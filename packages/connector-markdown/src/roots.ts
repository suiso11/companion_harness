/**
 * Configured roots: validation, deterministic aliasing, async init.
 *
 * CONFIG RULES (fail closed, `invalid_input`):
 * - `roots` is an array of 1..1024 entries.
 * - `path` is a non-empty absolute path with no NUL byte.
 * - `alias`, when given, is 1..64 chars matching
 *   `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` (safe non-path token: no `/`, `\`,
 *   `:`, NUL, or dot-segments, so it can never escape a canonical key).
 * - Aliases are unique. Omitted aliases are derived deterministically as
 *   `vault-1..N` after sorting roots by path in UTF-16 code-unit order.
 *
 * INIT (async): each root must exist and be a directory; its realpath is
 * resolved once and stored as the containment root. Two configured roots
 * resolving to the same realpath are rejected (duplicate vault identity
 * would otherwise fork canonical keys for one real file; internal
 * symlink/alias folding is handled by real-file identity at discovery).
 *
 * The absolute `requestedPath` and `realPath` stay inside this package:
 * only `{ alias }` pairs leave via `InitializedRootInfo`. Errors carry at
 * most an alias, never a path.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MarkdownConnectorError } from "./errors.js";

export interface ConfiguredRootInput {
  path: string;
  alias?: string;
}

/** Public, path-free view of an initialized root. */
export interface InitializedRootInfo {
  alias: string;
}

/** Initialized root (runtime-private absolute paths; package-internal). */
export interface InitializedRoot {
  alias: string;
  realPath: string;
  requestedPath: string;
}

const MAX_ROOTS = 1024;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function validateRootInputs(
  inputs: readonly ConfiguredRootInput[],
): { path: string; alias: string }[] {
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > MAX_ROOTS
  ) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  const entries: { path: string; alias: string | null }[] = inputs.map(
    (entry) => {
      if (typeof entry !== "object" || entry === null) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
      const rawPath = (entry as { path?: unknown }).path;
      const rawAlias = (entry as { alias?: unknown }).alias;
      if (typeof rawPath !== "string" || rawPath.length < 1) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
      if (rawPath.includes("\0")) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
      if (!path.isAbsolute(rawPath)) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
      let alias: string | null = null;
      if (rawAlias !== undefined) {
        if (typeof rawAlias !== "string" || !ALIAS_PATTERN.test(rawAlias)) {
          throw new MarkdownConnectorError("invalid_input", null);
        }
        alias = rawAlias;
      }
      return { path: rawPath, alias };
    },
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.alias !== null) {
      if (seen.has(entry.alias)) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
      seen.add(entry.alias);
    }
  }
  // Deterministic auto-aliasing: sort by path (code-unit order), then number.
  const ordered = [...entries].sort((a, b) => compareCodeUnits(a.path, b.path));
  let counter = 1;
  const assigned = new Map<{ path: string; alias: string | null }, string>();
  for (const entry of ordered) {
    if (entry.alias === null) {
      let candidate = `vault-${counter}`;
      counter += 1;
      while (seen.has(candidate)) {
        candidate = `vault-${counter}`;
        counter += 1;
      }
      seen.add(candidate);
      assigned.set(entry, candidate);
    } else {
      assigned.set(entry, entry.alias);
    }
  }
  return entries.map((entry) => ({
    path: entry.path,
    alias: assigned.get(entry) as string,
  }));
}

export async function initializeRoots(
  inputs: readonly ConfiguredRootInput[],
): Promise<InitializedRoot[]> {
  const validated = validateRootInputs(inputs);
  const roots: InitializedRoot[] = [];
  const seenReal = new Map<string, string>();
  for (const entry of validated) {
    let realPath: string;
    try {
      realPath = await fs.realpath(entry.path);
    } catch {
      throw new MarkdownConnectorError("invalid_input", entry.alias);
    }
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(realPath);
    } catch {
      throw new MarkdownConnectorError("invalid_input", entry.alias);
    }
    if (!stat.isDirectory()) {
      throw new MarkdownConnectorError("invalid_input", entry.alias);
    }
    const previous = seenReal.get(realPath);
    if (previous !== undefined) {
      void previous;
      throw new MarkdownConnectorError("invalid_input", entry.alias);
    }
    seenReal.set(realPath, entry.alias);
    roots.push({
      alias: entry.alias,
      realPath,
      requestedPath: entry.path,
    });
  }
  roots.sort((a, b) => compareCodeUnits(a.alias, b.alias));
  return roots;
}

/** True when `realFile` is the root itself or beneath it (real paths only). */
export function isWithinRealRoot(realRoot: string, realFile: string): boolean {
  if (realFile === realRoot) return true;
  return realFile.startsWith(realRoot + path.sep);
}
