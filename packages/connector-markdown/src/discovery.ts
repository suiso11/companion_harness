/**
 * Deterministic vault discovery over initialized roots.
 *
 * CONTRACT (exact, plan 14.6):
 * - Only files beneath configured roots are ever considered. Every candidate
 *   is resolved with `realpath` and required to stay within the root real
 *   path; any symlink (file or directory) resolving outside the root fails
 *   the whole call with `markdown_path_unsafe`.
 * - Internal aliases fold: file/directory symlinks that stay inside the root
 *   resolve to the same realpath and therefore the same canonical key
 *   (`<alias>/<realpath-relative posix>`). Deduplication is by realpath, so
 *   traversal order cannot change the result.
 * - Cycles cannot hang discovery: real directory paths are visited at most
 *   once, so symlink loops terminate.
 * - Directory metadata only: `readdir` + `realpath` + `stat`. No file
 *   content is ever opened or buffered during discovery.
 * - Vault bound enforced before any content byte: more than 10000 unique
 *   real `.md` targets in one vault fails the whole call with
 *   `markdown_vault_too_large` (10000 accepted, 10001 rejected).
 * - Determinism: entries are visited in UTF-16 code-unit order and the
 *   result is sorted by canonical key with explicit `<`/`>` comparison
 *   (never locale-sensitive APIs).
 * - Privacy: results and errors carry only alias-relative canonical keys or
 *   the alias itself; absolute paths and raw OS errors never escape.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MarkdownConnectorError } from "./errors.js";
import { type InitializedRoot, isWithinRealRoot } from "./roots.js";

/** Maximum unique real `.md` files accepted per vault (exact, plan 14.6). */
export const MAX_FILES_PER_VAULT = 10000;

/** A discovered Markdown file, identified only by its canonical key. */
export interface DiscoveredFile {
  readonly canonicalKey: string;
}

/** Minimal directory-entry view used by discovery (no content access). */
export interface DiscoveryDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/** Minimal stat view used by discovery (directory metadata only). */
export interface DiscoveryStat {
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Deterministic injection hooks for tests (e.g. synthesize 10001 entries
 * without creating 10001 disk files). Production passes no hooks, so the
 * default filesystem behavior is never weakened.
 */
export interface DiscoveryHooks {
  readdir?: (dirAbs: string) => Promise<readonly DiscoveryDirEntry[]>;
  realpath?: (candidateAbs: string) => Promise<string>;
  stat?: (targetAbs: string) => Promise<DiscoveryStat>;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Vault bound check (10000 accepted, 10001 rejected). Exported so tests can
 * assert the exact boundary without creating 10001 files on disk; discovery
 * itself calls this as unique real targets accumulate, before any content
 * byte is read.
 */
export function enforceVaultFileLimit(
  uniqueCount: number,
  alias: string,
): void {
  if (uniqueCount > MAX_FILES_PER_VAULT) {
    throw new MarkdownConnectorError("markdown_vault_too_large", alias);
  }
}

function toCanonicalKey(
  alias: string,
  realRoot: string,
  realFile: string,
): string {
  const relative = path.relative(realRoot, realFile);
  const posix = relative.split(path.sep).join("/");
  return `${alias}/${posix}`;
}

async function defaultReaddir(
  dirAbs: string,
): Promise<readonly DiscoveryDirEntry[]> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymbolicLink: entry.isSymbolicLink(),
  }));
}

/**
 * Discover unique real `.md` files for one vault. Suffix match is exact
 * lowercase `.md`; directories (including any named `*.md`) are traversed,
 * never returned. Non-regular kinds (sockets, fifos, devices) are ignored.
 */
export async function discoverMarkdownFilesForRoot(
  root: InitializedRoot,
  hooks: DiscoveryHooks = {},
): Promise<DiscoveredFile[]> {
  const readdir = hooks.readdir ?? defaultReaddir;
  const realpath = hooks.realpath ?? fs.realpath;
  const stat = hooks.stat ?? fs.stat;

  const seenDirs = new Set<string>([root.realPath]);
  const seenFiles = new Set<string>();
  const pending: string[] = [root.realPath];

  const classify = async (
    entryAbs: string,
    entry: DiscoveryDirEntry,
  ): Promise<{ real: string; isDir: boolean; isFile: boolean }> => {
    let real: string;
    try {
      real = await realpath(entryAbs);
    } catch {
      throw new MarkdownConnectorError(
        entry.isSymbolicLink ? "markdown_path_unsafe" : "markdown_read_failed",
        root.alias,
      );
    }
    if (!isWithinRealRoot(root.realPath, real)) {
      throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
    }
    // Symlink branches already know the entry is a link; plain entries and
    // unknown kinds (missing dirent type info) need a stat to classify.
    if (!entry.isSymbolicLink && (entry.isDirectory || entry.isFile)) {
      return {
        real,
        isDir: entry.isDirectory,
        isFile: entry.isFile,
      };
    }
    let target: DiscoveryStat;
    try {
      target = await stat(real);
    } catch {
      throw new MarkdownConnectorError("markdown_read_failed", root.alias);
    }
    return {
      real,
      isDir: target.isDirectory(),
      isFile: target.isFile(),
    };
  };

  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: readonly DiscoveryDirEntry[];
    try {
      entries = await readdir(dir);
    } catch {
      throw new MarkdownConnectorError("markdown_read_failed", root.alias);
    }
    const ordered = [...entries].sort((a, b) =>
      compareCodeUnits(a.name, b.name),
    );
    for (const entry of ordered) {
      if (entry.name === "" || entry.name === "." || entry.name === "..") {
        continue;
      }
      const entryAbs = path.join(dir, entry.name);
      const classified = await classify(entryAbs, entry);
      if (classified.isDir) {
        if (!seenDirs.has(classified.real)) {
          seenDirs.add(classified.real);
          pending.push(classified.real);
        }
        continue;
      }
      if (!classified.isFile) {
        continue;
      }
      if (!classified.real.endsWith(".md")) {
        continue;
      }
      if (!seenFiles.has(classified.real)) {
        seenFiles.add(classified.real);
        enforceVaultFileLimit(seenFiles.size, root.alias);
      }
    }
  }

  const keys = [...seenFiles]
    .map((real) => toCanonicalKey(root.alias, root.realPath, real))
    .sort(compareCodeUnits);
  return keys.map((canonicalKey) => ({ canonicalKey }));
}

/**
 * Discover across all initialized roots. The per-vault bound is enforced
 * independently for each root; the aggregate is sorted by canonical key in
 * code-unit order.
 */
export async function discoverMarkdownFiles(
  roots: readonly InitializedRoot[],
  hooks: DiscoveryHooks = {},
): Promise<DiscoveredFile[]> {
  const all: DiscoveredFile[] = [];
  for (const root of roots) {
    const found = await discoverMarkdownFilesForRoot(root, hooks);
    for (const entry of found) {
      all.push(entry);
    }
  }
  all.sort((a, b) => compareCodeUnits(a.canonicalKey, b.canonicalKey));
  return all;
}
