/**
 * Expanded link graph budget mirror (agreed, plan §14.6: 256KiB per tool
 * call).
 *
 * This package MUST NOT depend on `@companion/contracts` (no
 * package/lock/dependency changes), so the canonical framing defined in
 * contracts `references.ts` (`MAX_EXPANDED_LINK_GRAPH_BYTES` +
 * `serializeExpandedLinkGraphEntry` + incremental budget) is mirrored here
 * byte-for-byte. The framing is intentionally tiny and dependency-free so
 * the mirror cannot drift silently:
 * - Entry JSON: `{"candidates":[...],"kind":"...","ordinal":N,"status":"..."}`
 *   (this exact key insertion order; candidates in presented order;
 *   ordinal 1-based within the source document) via `JSON.stringify`.
 * - Graph bytes: `utf8ByteLength` of `[` + comma-joined entries + `]`.
 * - 262144 bytes accepted, 262145 rejected; `reference.open` /
 *   `reference.related` equivalents do not exist here (no graph expansion
 *   outside search/readCanonical presentation batches).
 * - Charged is ONLY persisted normalized metadata (kind / status /
 *   ordered path-free canonical candidates / ordering). Raw Markdown
 *   bodies, URLs, wiki targets, aliases, fragments, titles, snippets, and
 *   absolute paths are NEVER charged.
 *
 * CONSISTENCY: `link_budget.test.ts` (here) and contracts
 * `link_graph_budget.test.ts` pin IDENTICAL hardcoded vectors, so any
 * drift fails loudly in both packages. The kernel re-checks connector
 * output with the contracts implementation before any DB write, so a
 * drift can only ever fail safe (reject as `output_too_large`).
 */

/** Agreed budget: 256KiB of normalized graph metadata per tool call. */
export const LINK_GRAPH_BUDGET_BYTES = 262_144 as const;

/**
 * Minimum JSON bytes of one canonical candidate (`"a/b.md"`: the shortest
 * canonical key is 6 chars — 1-char alias + `/` + `x.md` — plus 2 quotes).
 * Canonical keys are never shorter, and JSON escaping only grows output,
 * so `8 * count` is always a safe lower bound for pre-checks (throwing on
 * the lower bound alone can never falsely reject).
 */
export const MIN_CANONICAL_CANDIDATE_JSON_BYTES = 8 as const;

export type LinkGraphKind = "standard" | "wiki";
export type LinkGraphStatus = "resolved" | "ambiguous" | "unresolved";

export interface LinkGraphEntry {
  readonly kind: LinkGraphKind;
  readonly status: LinkGraphStatus;
  readonly candidates: readonly string[];
  /** 1-based link index within the source document. */
  readonly ordinal: number;
}

/**
 * UTF-8 byte length (pure code-point walk, no Node globals; verbatim copy
 * of the contracts `utf8ByteLength` so astral text counts 4 bytes in both
 * packages).
 */
export function linkGraphUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (const unit of value) {
    const point = unit.codePointAt(0) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Deterministic JSON serialization of one graph entry (canonical framing). */
export function serializeLinkGraphEntry(entry: LinkGraphEntry): string {
  return JSON.stringify({
    candidates: [...entry.candidates],
    kind: entry.kind,
    ordinal: entry.ordinal,
    status: entry.status,
  });
}

/** Exact UTF-8 byte size of one serialized graph entry. */
export function measureLinkGraphEntryBytes(entry: LinkGraphEntry): number {
  return linkGraphUtf8ByteLength(serializeLinkGraphEntry(entry));
}

/**
 * Exact UTF-8 byte size of the whole batch graph (`[...entries...]`,
 * entries joined with ASCII commas inside ASCII brackets, so the
 * incremental budget below and this whole measure always agree).
 */
export function measureLinkGraphBytes(
  entries: readonly LinkGraphEntry[],
): number {
  return linkGraphUtf8ByteLength(
    `[${entries.map(serializeLinkGraphEntry).join(",")}]`,
  );
}

/**
 * Exact byte size of one entry without serializing the whole entry first.
 * Returns null when the entry alone already exceeds `cap`. Static framing
 * pieces are ASCII; each candidate contributes its own `JSON.stringify`
 * bytes (one bounded canonical key at a time, each at most 512 UTF-16
 * units) plus one comma separator (except the first). Mirrors contracts
 * `measureEntryBytesCapped` byte-for-byte.
 */
function measureEntryBytesCapped(
  entry: LinkGraphEntry,
  cap: number,
): number | null {
  let total =
    linkGraphUtf8ByteLength('{"candidates":[') +
    linkGraphUtf8ByteLength('],"kind":"') +
    linkGraphUtf8ByteLength(entry.kind) +
    linkGraphUtf8ByteLength('","ordinal":') +
    linkGraphUtf8ByteLength(String(entry.ordinal)) +
    linkGraphUtf8ByteLength(',"status":"') +
    linkGraphUtf8ByteLength(entry.status) +
    linkGraphUtf8ByteLength('"}');
  if (total > cap) return null;
  for (let index = 0; index < entry.candidates.length; index += 1) {
    if (index > 0) {
      total += 1; // comma between candidates (ASCII).
      if (total > cap) return null;
    }
    const candidate = entry.candidates[index] as string;
    const json = JSON.stringify(candidate) as string;
    total += linkGraphUtf8ByteLength(json);
    if (total > cap) return null;
  }
  return total;
}

export interface LinkGraphBudget {
  /** Current exact graph bytes (`2` for the empty `[]`). */
  readonly bytes: number;
  /** Number of accepted entries. */
  readonly count: number;
  /**
   * Accept one entry exactly when the resulting canonical total stays
   * within `limit`; otherwise return false leaving the budget unchanged
   * (the caller maps the overflow to `output_too_large`). Never truncates.
   * Defensive: candidates are measured one bounded key at a time with
   * early exit, never serializing a huge entry before the cap check.
   */
  readonly tryAddEntry: (entry: LinkGraphEntry) => boolean;
}

export function createLinkGraphBudget(
  limit: number = LINK_GRAPH_BUDGET_BYTES,
): LinkGraphBudget {
  let bytes = 2; // `[]`
  let count = 0;
  return {
    get bytes() {
      return bytes;
    },
    get count() {
      return count;
    },
    tryAddEntry(entry) {
      const remaining = limit - bytes - (count > 0 ? 1 : 0);
      const entryBytes = measureEntryBytesCapped(entry, remaining);
      if (entryBytes === null) {
        return false;
      }
      bytes += entryBytes + (count > 0 ? 1 : 0);
      count += 1;
      return true;
    },
  };
}
