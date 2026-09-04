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
 * 4. Fallback when `O_NOFOLLOW` is unavailable (Windows) or the open
 *    reports `EINVAL`/`ENOSYS`/`EOPNOTSUPP`: before any fallback open, run
 *    a component check that `lstat`s every canonical path component from
 *    the root through the final file (canonical `preReal` only,
 *    containment re-checked, UTF-16 code-unit segments). The root and the
 *    final component must be non-symlinks; every parent must be a
 *    non-symlink directory; the final component must be a non-symlink
 *    regular file. Any symlink fails `markdown_path_unsafe`; a missing or
 *    wrong-kind component fails `markdown_read_failed`; the safe canonical
 *    key alone is carried. No content byte is consumed before this check
 *    plus the open-`fstat` identity comparison below.
 * 5. Pre-read `fstat` identity compare: descriptor identity must equal the
 *    pre-stat identity before a single content byte is consumed, so bytes
 *    from a swapped target can never reach the comparison logic, let alone
 *    the caller.
 * 6. Bounded chunk reads (`64KiB` slices) that stop after `1MiB + 1` bytes.
 *    The whole file is never buffered at once; growth past the bound is an
 *    explicit `file_too_large` skip, never a truncation.
 * 7. Post-`fstat` identity/size/mtime plus post-`realpath` checks. Any
 *    mismatch fails with `markdown_read_changed`; an escape fails with
 *    `markdown_path_unsafe`. Bytes from a changed file are discarded.
 *    Post checks always run before an oversize-during-read skip is
 *    returned: an oversize read whose descriptor identity or post-realpath
 *    moved (swap/escape) fails `markdown_read_changed`/`markdown_path_unsafe`
 *    first; only a stable-identity (same `dev`/`ino`/kind, same contained
 *    realpath) oversize returns `file_too_large`. Size/mtime drift alone on
 *    the oversize path is treated as the growth that caused the oversize,
 *    not as a change error.
 * 8. Fatal UTF-8 decode (`invalid_utf8` skip, never replacement text) and
 *    NFC normalization; a normalized form above 1MiB UTF-8 bytes is a
 *    `file_too_large` skip.
 *
 * ERRORS: only `markdown_path_unsafe` / `markdown_read_failed` /
 * `markdown_read_changed`, each carrying the alias-relative canonical key
 * (never an absolute path or raw OS error). Oversize and bad-encoding files
 * are explicit skips, not throws. Malformed keys fail `markdown_path_unsafe`
 * carrying only the configured alias (never echoing the raw input).
 *
 * PLATFORM LIMITATION (honest TOCTOU note): on platforms without
 * `O_NOFOLLOW` (Windows), the fallback open necessarily follows a final
 * component planted between the component check and the open. The component
 * `lstat` check plus the pre-read `fstat` identity compare still run before
 * any byte is consumed, and the post-`fstat` / post-`realpath` checks still
 * discard the bytes on mismatch, so a swapped target can never be *returned*
 * — but it may be briefly *buffered* before the mismatch is detected.
 * Double-swap races (changed away and back before the post check, or swapped
 * in the gap between component check and open and swapped back before the
 * post check) remain a residual risk on every platform; mitigated by
 * comparing `size`/`mtimeMs` in addition to `dev`/`ino`/kind on the
 * non-oversize path, not eliminated. No construction here claims perfect
 * elimination of double-swap TOCTOU.
 *
 * INJECTION HOOKS: `afterPreStat` / `afterOpen` / `afterRead` run at the
 * exact TOCTOU windows so tests can deterministically swap or mutate the
 * file and assert `markdown_read_changed`. `forceNoFollowUnsupported` forces
 * the no-follow-unavailable fallback path on any platform so tests can
 * exercise component verification deterministically; `lstat` overrides the
 * filesystem `lstat` used only by that verification. They default to
 * no-ops / production behavior, so production is never weakened.
 */

import type { Stats } from "node:fs";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { MAX_CANONICAL_KEY_UTF16 } from "./discovery.js";
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
 * size, and UTF-8 rules are never weakened. `forceNoFollowUnsupported`
 * forces the fallback component-verification path even where `O_NOFOLLOW`
 * is available; `lstat` overrides only the fallback verification `lstat`. */
export interface SafeReadHooks {
  afterPreStat?: () => Promise<void> | void;
  afterOpen?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
  signal?: AbortSignal;
  /** Test-only: force the no-follow-unavailable fallback path. */
  forceNoFollowUnsupported?: boolean;
  /** Test-only: override `lstat` used by fallback component verification. */
  lstat?: (targetAbs: string) => Promise<Stats>;
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
    // Windows rejects colon segments to avoid drive/ADS ambiguity; POSIX
    // permits colon in relative filename segments (e.g. `notes:2026.md`).
    // Alias grammar stays colon-free on all platforms (prefix check above).
    // Blocked inputs never echo: the caller only ever sees the safe alias.
    if (process.platform === "win32" && segment.includes(":")) {
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
 * Fallback component verification for the no-follow-unavailable path.
 * Uses `lstat` only, over the canonical `preReal` path only. Re-checks
 * containment, splits UTF-16 code-unit segments on the platform separator,
 * then `lstat`s the root plus every joined prefix. The root must be a
 * non-symlink directory; every parent must be a non-symlink directory; the
 * final component must be a non-symlink regular file. Symlinks fail
 * `markdown_path_unsafe`; missing components or wrong kinds fail
 * `markdown_read_failed`; only the safe canonical key is carried.
 */
async function verifyFallbackComponents(
  root: InitializedRoot,
  preReal: string,
  key: string,
  lstatImpl: (targetAbs: string) => Promise<Stats>,
): Promise<void> {
  if (!isWithinRealRoot(root.realPath, preReal)) {
    throw new MarkdownConnectorError("markdown_path_unsafe", key);
  }
  const relative = path.relative(root.realPath, preReal);
  if (relative === "") {
    throw new MarkdownConnectorError("markdown_read_failed", key);
  }
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new MarkdownConnectorError("markdown_path_unsafe", key);
  }
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\0") ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
    // Windows rejects colon segments (drive/ADS ambiguity); POSIX permits
    // colon in relative filename segments.
    if (process.platform === "win32" && segment.includes(":")) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
  }
  const lstatOne = async (targetAbs: string): Promise<Stats> => {
    try {
      return await lstatImpl(targetAbs);
    } catch {
      throw new MarkdownConnectorError("markdown_read_failed", key);
    }
  };
  const rootStat = await lstatOne(root.realPath);
  if (
    typeof rootStat.isSymbolicLink === "function" &&
    rootStat.isSymbolicLink()
  ) {
    throw new MarkdownConnectorError("markdown_path_unsafe", key);
  }
  if (!rootStat.isDirectory()) {
    throw new MarkdownConnectorError("markdown_read_failed", key);
  }
  let current = root.realPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    current = path.join(current, segment);
    const st = await lstatOne(current);
    if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
    const isLast = index === segments.length - 1;
    if (isLast) {
      if (!st.isFile()) {
        throw new MarkdownConnectorError("markdown_read_failed", key);
      }
    } else {
      if (!st.isDirectory()) {
        throw new MarkdownConnectorError("markdown_path_unsafe", key);
      }
    }
  }
}

/**
 * Read one file identified by its canonical key. The key must be a
 * well-formed `<alias>/<relative-posix>` key for this root; anything else
 * fails with `markdown_path_unsafe` carrying only the alias. Alias grammar
 * stays colon-free on all platforms; relative segments may contain `:` on
 * POSIX (e.g. `notes:2026.md`) and are rejected on Windows to avoid
 * drive/ADS ambiguity. Drive (`C:/...`) or scheme-like alias mismatches
 * never echo back.
 */
export async function safeReadMarkdownFile(
  root: InitializedRoot,
  canonicalKey: string,
  hooks: SafeReadHooks = {},
): Promise<SafeReadResult> {
  if (typeof canonicalKey !== "string") {
    throw new MarkdownConnectorError("markdown_path_unsafe", null);
  }
  // Downstream key bound (UTF-16 units, matches CanonicalKeySchema max):
  // overlong keys fail before any resolve/stat/open byte is touched.
  if (canonicalKey.length > MAX_CANONICAL_KEY_UTF16) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
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

  const lstatImpl = hooks.lstat ?? ((targetAbs: string) => fs.lstat(targetAbs));
  const noFollowAvailable =
    hooks.forceNoFollowUnsupported === true ? false : isNoFollowSupported();
  const nofollow = noFollowAvailable ? (constants.O_NOFOLLOW as number) : 0;
  // On the no-follow-unavailable path no byte may be touched before the
  // component check runs; the check itself uses lstat only.
  if (!noFollowAvailable) {
    await verifyFallbackComponents(root, preReal, key, lstatImpl);
    throwIfAborted(signal);
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(preReal, constants.O_RDONLY | nofollow);
  } catch (error) {
    if (isNoFollowTrap(error)) {
      throw new MarkdownConnectorError("markdown_path_unsafe", key);
    }
    if (nofollow !== 0 && isUnsupportedFlag(error)) {
      await verifyFallbackComponents(root, preReal, key, lstatImpl);
      throwIfAborted(signal);
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

    await hooks.afterRead?.();
    throwIfAborted(signal);

    const runPostChecks = async (): Promise<void> => {
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
      if (oversize) {
        // Oversize precedence: a swapped/escaped target still fails
        // changed/unsafe; only a stable-identity contained target skips.
        // Size/mtime drift alone is the growth that caused the oversize.
        if (!sameIdentity(pre, postIdentity)) {
          throw new MarkdownConnectorError("markdown_read_changed", key);
        }
      } else {
        if (
          !sameIdentity(pre, postIdentity) ||
          post.size !== pre.size ||
          post.mtimeMs !== pre.mtimeMs
        ) {
          throw new MarkdownConnectorError("markdown_read_changed", key);
        }
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
    };
    await runPostChecks();
    throwIfAborted(signal);
    if (oversize) {
      return { status: "skipped", canonicalKey: key, reason: "file_too_large" };
    }

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
