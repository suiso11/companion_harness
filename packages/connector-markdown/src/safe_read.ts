/**
 * Bounded safe read of a single discovered Markdown file.
 *
 * EXACT SEQUENCE (plan 14.6 / 14.10):
 * 1. Re-resolve the caller key against the live root (`realpath` of the
 *    joined candidate) and require containment; then `stat` the resolved
 *    target and capture its stable identity (`dev`/`ino` plus file kind)
 *    with `size`/`mtimeMs`. Discovery output is never trusted blindly.
 * 2. Oversize pre-skip on metadata alone: `size` above 1MiB returns an
 *    explicit `file_too_large` skip with zero content bytes touched.
 * 3. Open the canonical (resolved) target with `O_NOFOLLOW` where the
 *    platform supports it. An `ELOOP` trap (final component swapped to a
 *    symlink mid-call) fails the whole read with `markdown_path_unsafe`.
 * 4. Pre-read `fstat` identity compare: descriptor identity must equal the
 *    pre-stat identity before a single content byte is consumed, so bytes
 *    from a swapped target can never reach the comparison logic, let alone
 *    the caller.
 * 5. Bounded chunk reads (`64KiB` slices) that stop after `1MiB + 1` bytes.
 *    The whole file is never buffered at once; growth past the bound is an
 *    explicit `file_too_large` skip, never a truncation.
 * 6. Post-`fstat` identity/size/mtime plus post-`realpath` checks. Any
 *    mismatch fails with `markdown_read_changed`; an escape fails with
 *    `markdown_path_unsafe`. Bytes from a changed file are discarded.
 * 7. Fatal UTF-8 decode (`invalid_utf8` skip, never replacement text) and
 *    NFC normalization; a normalized form above 1MiB UTF-8 bytes is a
 *    `file_too_large` skip.
 *
 * ERRORS: only `markdown_path_unsafe` / `markdown_read_failed` /
 * `markdown_read_changed`, each carrying the alias-relative canonical key
 * (never an absolute path or raw OS error). Oversize and bad-encoding files
 * are explicit skips, not throws.
 *
 * PLATFORM LIMITATION (honest TOCTOU note): on platforms without
 * `O_NOFOLLOW` (Windows), the open necessarily follows a final-component
 * symlink planted between pre-stat and open. The pre-read `fstat` identity
 * compare still runs before any byte is consumed, and the post-`fstat` /
 * post-`realpath` checks still discard the bytes on mismatch, so a swapped
 * target can never be *returned* — but it may be briefly *buffered* before
 * the mismatch is detected. Double-swap races (changed back before the post
 * check) remain a residual risk on every platform; mitigated by comparing
 * `size`/`mtimeMs` in addition to `dev`/`ino`/kind, not eliminated.
 *
 * INJECTION HOOKS: `afterPreStat` / `afterOpen` / `afterRead` run at the
 * exact TOCTOU windows so tests can deterministically swap or mutate the
 * file and assert `markdown_read_changed`. They default to no-ops, so
 * production behavior is never weakened.
 */

import type { Stats } from "node:fs";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { MarkdownConnectorError } from "./errors.js";
import { type InitializedRoot, isWithinRealRoot } from "./roots.js";

/** Maximum raw or NFC-normalized UTF-8 bytes accepted per file (plan 14.6). */
export const MAX_FILE_BYTES = 1_048_576;

/** Chunk size for bounded reads; total buffering never exceeds 1MiB + 1. */
const CHUNK_BYTES = 65_536;

/** Deterministic TOCTOU windows for tests; no-ops unless provided. `signal`
 * adds cooperative cancellation: it is checked before every potentially
 * long stage (resolve, stat, open, each chunk, post-checks, decode) and an
 * abort throws an `AbortError` carrying no path or content. Buffered bytes
 * are discarded on abort; containment, identity, post-fstat, close-finally,
 * size, and UTF-8 rules are never weakened. */
export interface SafeReadHooks {
  afterPreStat?: () => Promise<void> | void;
  afterOpen?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

export type SafeReadResult =
  | { status: "ok"; canonicalKey: string; text: string }
  | {
      status: "skipped";
      canonicalKey: string;
      reason: "file_too_large" | "invalid_utf8";
    };

/** True where `O_NOFOLLOW` open semantics can be enforced (non-Windows). */
export function isNoFollowSupported(): boolean {
  const flag: unknown = constants.O_NOFOLLOW;
  return typeof flag === "number" && flag !== 0 && process.platform !== "win32";
}

interface FileIdentity {
  dev: number;
  ino: number;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile === b.isFile;
}

function parseRelativeSegments(
  root: InitializedRoot,
  canonicalKey: string,
): string[] | null {
  const prefix = `${root.alias}/`;
  if (!canonicalKey.startsWith(prefix)) {
    return null;
  }
  const rest = canonicalKey.slice(prefix.length);
  if (rest === "" || rest.includes("\\") || rest.includes("\0")) {
    return null;
  }
  const segments = rest.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return null;
    }
  }
  return segments;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isNoFollowTrap(error: unknown): boolean {
  return errorCodeOf(error) === "ELOOP";
}

function isUnsupportedFlag(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === "EINVAL" || code === "ENOSYS" || code === "EOPNOTSUPP";
}

/**
 * Read one file identified by its canonical key. The key must be a
 * well-formed `<alias>/<relative-posix>` key for this root; anything else
 * (including absolute-looking input, which is never echoed back) fails with
 * `markdown_path_unsafe` carrying only the alias.
 */
export async function safeReadMarkdownFile(
  root: InitializedRoot,
  canonicalKey: string,
  hooks: SafeReadHooks = {},
): Promise<SafeReadResult> {
  if (typeof canonicalKey !== "string") {
    throw new MarkdownConnectorError("markdown_path_unsafe", null);
  }
  const signal = hooks.signal;
  throwIfAborted(signal);
  const segments = parseRelativeSegments(root, canonicalKey);
  if (segments === null) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  const key = canonicalKey;
  const candidateAbs = path.join(root.realPath, ...segments);

  let preReal: string;
  try {
    preReal = await fs.realpath(candidateAbs);
  } catch {
    throw new MarkdownConnectorError("markdown_read_failed", key);
  }
  throwIfAborted(signal);
  if (!isWithinRealRoot(root.realPath, preReal)) {
    throw new MarkdownConnectorError("markdown_path_unsafe", key);
  }
  let preStat: Stats;
  try {
    preStat = await fs.stat(preReal);
  } catch {
    throw new MarkdownConnectorError("markdown_read_failed", key);
  }
  throwIfAborted(signal);
  if (!preStat.isFile()) {
    throw new MarkdownConnectorError("markdown_read_failed", key);
  }
  const pre: FileIdentity = {
    dev: preStat.dev,
    ino: preStat.ino,
    isFile: true,
    size: preStat.size,
    mtimeMs: preStat.mtimeMs,
  };
  if (pre.size > MAX_FILE_BYTES) {
    return { status: "skipped", canonicalKey: key, reason: "file_too_large" };
  }

  await hooks.afterPreStat?.();
  throwIfAborted(signal);

  const nofollow = isNoFollowSupported() ? (constants.O_NOFOLLOW as number) : 0;
  let handle: FileHandle;
  try {
    handle = await fs.open(preReal, constants.O_RDONLY | nofollow);
  } catch (error) {
    if (isNoFollowTrap(error)) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
    if (nofollow !== 0 && isUnsupportedFlag(error)) {
      try {
        handle = await fs.open(preReal, constants.O_RDONLY);
      } catch (retryError) {
        if (isNoFollowTrap(retryError)) {
          throw new MarkdownConnectorError("markdown_path_unsafe", key);
        }
        throw new MarkdownConnectorError("markdown_read_failed", key);
      }
    } else {
      throw new MarkdownConnectorError("markdown_read_failed", key);
    }
  }

  try {
    let opened: Stats;
    try {
      opened = await handle.stat();
    } catch {
      throw new MarkdownConnectorError("markdown_read_failed", key);
    }
    const openedIdentity: FileIdentity = {
      dev: opened.dev,
      ino: opened.ino,
      isFile: opened.isFile(),
      size: opened.size,
      mtimeMs: opened.mtimeMs,
    };
    if (!sameIdentity(pre, openedIdentity)) {
      throw new MarkdownConnectorError("markdown_read_changed", key);
    }
    throwIfAborted(signal);

    await hooks.afterOpen?.();
    throwIfAborted(signal);

    const parts: Buffer[] = [];
    let total = 0;
    let position = 0;
    let oversize = false;
    while (total <= MAX_FILE_BYTES) {
      throwIfAborted(signal);
      const want = Math.min(CHUNK_BYTES, MAX_FILE_BYTES + 1 - total);
      const buffer = Buffer.alloc(want);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, want, position));
      } catch {
        throw new MarkdownConnectorError("markdown_read_failed", key);
      }
      if (bytesRead === 0) {
        break;
      }
      parts.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
      if (total > MAX_FILE_BYTES) {
        oversize = true;
        break;
      }
    }
    if (oversize) {
      return { status: "skipped", canonicalKey: key, reason: "file_too_large" };
    }

    await hooks.afterRead?.();
    throwIfAborted(signal);

    let post: Stats;
    try {
      post = await handle.stat();
    } catch {
      throw new MarkdownConnectorError("markdown_read_failed", key);
    }
    const postIdentity: FileIdentity = {
      dev: post.dev,
      ino: post.ino,
      isFile: post.isFile(),
      size: post.size,
      mtimeMs: post.mtimeMs,
    };
    if (
      !sameIdentity(pre, postIdentity) ||
      post.size !== pre.size ||
      post.mtimeMs !== pre.mtimeMs
    ) {
      throw new MarkdownConnectorError("markdown_read_changed", key);
    }
    let postReal: string;
    try {
      postReal = await fs.realpath(candidateAbs);
    } catch {
      throw new MarkdownConnectorError("markdown_read_changed", key);
    }
    if (!isWithinRealRoot(root.realPath, postReal)) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
    if (postReal !== preReal) {
      throw new MarkdownConnectorError("markdown_read_changed", key);
    }
    throwIfAborted(signal);

    const raw = Buffer.concat(parts, total);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return { status: "skipped", canonicalKey: key, reason: "invalid_utf8" };
    }
    const normalized = text.normalize("NFC");
    if (Buffer.byteLength(normalized, "utf8") > MAX_FILE_BYTES) {
      return { status: "skipped", canonicalKey: key, reason: "file_too_large" };
    }
    return { status: "ok", canonicalKey: key, text: normalized };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
