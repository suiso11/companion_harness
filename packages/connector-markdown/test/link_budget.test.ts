/**
 * Expanded link graph budget mirror vectors (agreed, plan §14.6: exactly
 * 256KiB / 262144 UTF-8 bytes per tool call, canonical JSON framing).
 *
 * CONSISTENCY: this file and contracts `link_graph_budget.test.ts` pin
 * IDENTICAL hardcoded vectors (same entries, same expected serializations,
 * same boundaries), so any mirror drift fails loudly in both packages.
 * Ground truth is always `JSON.stringify` + `Buffer.byteLength(..., "utf8")`
 * (Node test-only); the dependency-free `linkGraphUtf8ByteLength` must agree
 * byte-for-byte, including astral / quote / backslash escaping.
 */

import { describe, expect, it } from "vitest";
import {
  createLinkGraphBudget,
  LINK_GRAPH_BUDGET_BYTES,
  linkGraphUtf8ByteLength,
  type LinkGraphEntry,
  measureLinkGraphBytes,
  measureLinkGraphEntryBytes,
  MIN_CANONICAL_CANDIDATE_JSON_BYTES,
  serializeLinkGraphEntry,
} from "../src/link_budget.js";

const CAP = 262_144;

function groundTruthBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("link graph budget mirror vectors", () => {
  it("fixes the agreed cap at exactly 256KiB with an 8-byte candidate floor", () => {
    expect(LINK_GRAPH_BUDGET_BYTES).toBe(CAP);
    expect(MIN_CANONICAL_CANDIDATE_JSON_BYTES).toBe(8);
    // Shortest canonical key `a/b.md` (6 chars) + 2 JSON quotes.
    expect(JSON.stringify("a/b.md")).toBe('"a/b.md"');
    expect(groundTruthBytes(JSON.stringify("a/b.md"))).toBe(8);
  });

  it("starts from the empty graph `[]` (2 bytes)", () => {
    const budget = createLinkGraphBudget();
    expect(budget.bytes).toBe(2);
    expect(budget.count).toBe(0);
    expect(measureLinkGraphBytes([])).toBe(2);
  });

  it("counts UTF-8 bytes (not code points or UTF-16 units)", () => {
    expect(linkGraphUtf8ByteLength("a")).toBe(1);
    expect(linkGraphUtf8ByteLength("é")).toBe(2);
    expect(linkGraphUtf8ByteLength("あ")).toBe(3);
    expect(linkGraphUtf8ByteLength("😀")).toBe(4);
    for (const sample of ["a", "é", "あ", "😀", "v/😀.md", 'v/a"b\\c.md']) {
      expect(linkGraphUtf8ByteLength(sample)).toBe(groundTruthBytes(sample));
    }
  });

  it("serializes entries with exact key order (candidates/kind/ordinal/status)", () => {
    const standard: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a/b.md"],
      ordinal: 1,
    };
    expect(serializeLinkGraphEntry(standard)).toBe(
      '{"candidates":["a/b.md"],"kind":"standard","ordinal":1,"status":"resolved"}',
    );
    const ambiguous: LinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: ["v/a/Note.md", "v/b/Note.md"],
      ordinal: 2,
    };
    expect(serializeLinkGraphEntry(ambiguous)).toBe(
      '{"candidates":["v/a/Note.md","v/b/Note.md"],"kind":"wiki","ordinal":2,"status":"ambiguous"}',
    );
    const unresolved: LinkGraphEntry = {
      kind: "standard",
      status: "unresolved",
      candidates: [],
      ordinal: 1024,
    };
    expect(serializeLinkGraphEntry(unresolved)).toBe(
      '{"candidates":[],"kind":"standard","ordinal":1024,"status":"unresolved"}',
    );
    const wikiEmpty: LinkGraphEntry = {
      kind: "wiki",
      status: "unresolved",
      candidates: [],
      ordinal: 3,
    };
    expect(serializeLinkGraphEntry(wikiEmpty)).toBe(
      '{"candidates":[],"kind":"wiki","ordinal":3,"status":"unresolved"}',
    );
  });

  it("measures entries exactly (JSON.stringify + UTF-8 ground truth)", () => {
    const entries: readonly LinkGraphEntry[] = [
      { kind: "standard", status: "resolved", candidates: ["a/b.md"], ordinal: 1 },
      {
        kind: "wiki",
        status: "ambiguous",
        candidates: ["v/a/Note.md", "v/b/Note.md"],
        ordinal: 2,
      },
      { kind: "standard", status: "unresolved", candidates: [], ordinal: 1024 },
      { kind: "wiki", status: "unresolved", candidates: [], ordinal: 3 },
    ];
    for (const entry of entries) {
      expect(measureLinkGraphEntryBytes(entry)).toBe(
        groundTruthBytes(serializeLinkGraphEntry(entry)),
      );
    }
    const whole = `[${entries.map(serializeLinkGraphEntry).join(",")}]`;
    expect(measureLinkGraphBytes(entries)).toBe(groundTruthBytes(whole));
  });

  it("charges astral candidates as 4 UTF-8 bytes per code point", () => {
    const entry: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["v/😀.md"],
      ordinal: 1,
    };
    expect(serializeLinkGraphEntry(entry)).toBe(
      '{"candidates":["v/😀.md"],"kind":"standard","ordinal":1,"status":"resolved"}',
    );
    // `v/😀.md`: v(1) /(1) 😀(4) .(1) m(1) d(1) = 9 + 2 quotes = 11.
    expect(groundTruthBytes(JSON.stringify("v/😀.md"))).toBe(11);
    expect(measureLinkGraphEntryBytes(entry)).toBe(
      groundTruthBytes(serializeLinkGraphEntry(entry)),
    );
    expect(linkGraphUtf8ByteLength(serializeLinkGraphEntry(entry))).toBe(
      groundTruthBytes(serializeLinkGraphEntry(entry)),
    );
  });

  it("charges quote/backslash escapes exactly (JSON escaping only grows output)", () => {
    const candidate = 'v/a"b\\c.md';
    const json = JSON.stringify(candidate);
    expect(json).toBe('"v/a\\"b\\\\c.md"');
    expect(groundTruthBytes(json)).toBeGreaterThan(candidate.length + 2);
    const entry: LinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: [candidate, "v/plain.md"],
      ordinal: 7,
    };
    expect(measureLinkGraphEntryBytes(entry)).toBe(
      groundTruthBytes(serializeLinkGraphEntry(entry)),
    );
  });

  it("keeps the incremental budget identical to the whole-graph measure", () => {
    const entries: readonly LinkGraphEntry[] = [
      { kind: "standard", status: "resolved", candidates: ["a/b.md"], ordinal: 1 },
      {
        kind: "wiki",
        status: "ambiguous",
        candidates: ["v/a/Note.md", "v/b/Note.md"],
        ordinal: 2,
      },
      { kind: "standard", status: "unresolved", candidates: [], ordinal: 3 },
      { kind: "wiki", status: "resolved", candidates: ["v/😀.md"], ordinal: 4 },
    ];
    const budget = createLinkGraphBudget();
    const accepted: LinkGraphEntry[] = [];
    for (const entry of entries) {
      expect(budget.tryAddEntry(entry)).toBe(true);
      accepted.push(entry);
      expect(budget.bytes).toBe(measureLinkGraphBytes(accepted));
      expect(budget.count).toBe(accepted.length);
    }
  });

  it("charges repeated candidates per occurrence and unresolved entries too", () => {
    const entry: LinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: ["v/a/Note.md", "v/b/Note.md"],
      ordinal: 1,
    };
    const once = createLinkGraphBudget();
    expect(once.tryAddEntry(entry)).toBe(true);
    const twice = createLinkGraphBudget();
    expect(twice.tryAddEntry(entry)).toBe(true);
    // Same candidate repeated: no dedup across entries, charged twice.
    expect(twice.tryAddEntry({ ...entry, ordinal: 2 })).toBe(true);
    expect(twice.bytes).toBe(measureLinkGraphBytes([entry, { ...entry, ordinal: 2 }]));
    expect(twice.bytes).toBeGreaterThan(once.bytes);
    expect(twice.count).toBe(2);
    // Unresolved entries (empty candidates) still consume framing bytes.
    const empty = createLinkGraphBudget();
    expect(
      empty.tryAddEntry({
        kind: "standard",
        status: "unresolved",
        candidates: [],
        ordinal: 1,
      }),
    ).toBe(true);
    expect(empty.bytes).toBeGreaterThan(2);
  });

  it("accepts exactly 262144 bytes and rejects 262145 (single entry)", () => {
    const probe: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: [""],
      ordinal: 1,
    };
    const staticOverhead = measureLinkGraphEntryBytes(probe) - 2;
    const fillLength = CAP - 2 - staticOverhead - 2;
    expect(fillLength).toBeGreaterThan(0);
    const exact: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(fillLength)],
      ordinal: 1,
    };
    expect(measureLinkGraphBytes([exact])).toBe(CAP);
    const ok = createLinkGraphBudget();
    expect(ok.tryAddEntry(exact)).toBe(true);
    expect(ok.bytes).toBe(CAP);
    expect(ok.count).toBe(1);
    const over: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(fillLength + 1)],
      ordinal: 1,
    };
    expect(measureLinkGraphBytes([over])).toBe(CAP + 1);
    const denied = createLinkGraphBudget();
    expect(denied.tryAddEntry(over)).toBe(false);
    expect(denied.bytes).toBe(2);
    expect(denied.count).toBe(0);
  });

  it("accepts a multi-entry graph at exactly 262144 then rejects the next entry", () => {
    const budget = createLinkGraphBudget();
    const accepted: LinkGraphEntry[] = [];
    // Fixed head of small entries (well below cap), then one crafted ascii
    // tail candidate lands the total at exactly the cap.
    for (let index = 0; index < 100; index += 1) {
      const entry: LinkGraphEntry = {
        kind: "standard",
        status: "unresolved",
        candidates: [],
        ordinal: index + 1,
      };
      expect(budget.tryAddEntry(entry)).toBe(true);
      accepted.push(entry);
    }
    const remaining = CAP - budget.bytes - 1; // 1 byte inter-entry comma.
    expect(remaining).toBeGreaterThan(1000);
    const tailProbe: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: [""],
      ordinal: accepted.length + 1,
    };
    const overhead = measureLinkGraphEntryBytes(tailProbe) - 2;
    const length = remaining - overhead - 2;
    expect(length).toBeGreaterThan(0);
    const tail: LinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(length)],
      ordinal: accepted.length + 1,
    };
    expect(budget.tryAddEntry(tail)).toBe(true);
    accepted.push(tail);
    expect(budget.bytes).toBe(CAP);
    expect(budget.bytes).toBe(measureLinkGraphBytes(accepted));
    const before = { bytes: budget.bytes, count: budget.count };
    expect(
      budget.tryAddEntry({
        kind: "standard",
        status: "unresolved",
        candidates: [],
        ordinal: accepted.length + 1,
      }),
    ).toBe(false);
    expect(budget.bytes).toBe(before.bytes);
    expect(budget.count).toBe(before.count);
  });

  it("rejects a pathological candidate list without retaining it", () => {
    const budget = createLinkGraphBudget();
    const huge: LinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: Array.from({ length: 20_000 }, (_, i) => `v/d${i}/Note.md`),
      ordinal: 1,
    };
    expect(measureLinkGraphBytes([huge])).toBeGreaterThan(CAP);
    expect(budget.tryAddEntry(huge)).toBe(false);
    expect(budget.bytes).toBe(2);
    expect(budget.count).toBe(0);
    // Ordinary entries still fit afterwards (rejection retained nothing).
    expect(
      budget.tryAddEntry({
        kind: "standard",
        status: "resolved",
        candidates: ["a/b.md"],
        ordinal: 1,
      }),
    ).toBe(true);
  });
});
