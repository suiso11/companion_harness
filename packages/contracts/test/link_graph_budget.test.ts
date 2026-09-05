/**
 * Expanded link graph budget vectors (agreed, §14.6: exactly 256KiB /
 * 262144 UTF-8 bytes per tool call, canonical JSON framing).
 *
 * CONSISTENCY: this file and connector-markdown `link_budget.test.ts` pin
 * IDENTICAL hardcoded vectors (same entries, same expected serializations,
 * same boundaries), so any mirror drift fails loudly in both packages.
 * Ground truth is always `JSON.stringify` + `Buffer.byteLength(..., "utf8")`
 * (Node test-only); the dependency-free `utf8ByteLength` must agree
 * byte-for-byte, including astral / quote / backslash escaping.
 */

import { describe, expect, it } from "vitest";
import {
  createExpandedLinkGraphBudget,
  type ExpandedLinkGraphEntry,
  MAX_EXPANDED_LINK_GRAPH_BYTES,
  measureExpandedLinkGraphBytes,
  measureExpandedLinkGraphEntryBytes,
  serializeExpandedLinkGraphEntry,
  utf8ByteLength,
} from "../src/index.js";

const CAP = 262_144;

function groundTruthBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("expanded link graph budget vectors", () => {
  it("fixes the agreed cap at exactly 256KiB with an 8-byte candidate floor", () => {
    expect(MAX_EXPANDED_LINK_GRAPH_BYTES).toBe(CAP);
    // Shortest canonical key `a/b.md` (6 chars) + 2 JSON quotes.
    expect(JSON.stringify("a/b.md")).toBe('"a/b.md"');
    expect(groundTruthBytes(JSON.stringify("a/b.md"))).toBe(8);
  });

  it("starts from the empty graph `[]` (2 bytes)", () => {
    const budget = createExpandedLinkGraphBudget();
    expect(budget.bytes).toBe(2);
    expect(budget.count).toBe(0);
    expect(measureExpandedLinkGraphBytes([])).toBe(2);
  });

  it("counts UTF-8 bytes (not code points or UTF-16 units)", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("あ")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    for (const sample of ["a", "é", "あ", "😀", "v/😀.md", 'v/a"b\\c.md']) {
      expect(utf8ByteLength(sample)).toBe(groundTruthBytes(sample));
    }
  });

  it("serializes entries with exact key order (candidates/kind/ordinal/status)", () => {
    const standard: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a/b.md"],
      ordinal: 1,
    };
    expect(serializeExpandedLinkGraphEntry(standard)).toBe(
      '{"candidates":["a/b.md"],"kind":"standard","ordinal":1,"status":"resolved"}',
    );
    const ambiguous: ExpandedLinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: ["v/a/Note.md", "v/b/Note.md"],
      ordinal: 2,
    };
    expect(serializeExpandedLinkGraphEntry(ambiguous)).toBe(
      '{"candidates":["v/a/Note.md","v/b/Note.md"],"kind":"wiki","ordinal":2,"status":"ambiguous"}',
    );
    const unresolved: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "unresolved",
      candidates: [],
      ordinal: 1024,
    };
    expect(serializeExpandedLinkGraphEntry(unresolved)).toBe(
      '{"candidates":[],"kind":"standard","ordinal":1024,"status":"unresolved"}',
    );
    const wikiEmpty: ExpandedLinkGraphEntry = {
      kind: "wiki",
      status: "unresolved",
      candidates: [],
      ordinal: 3,
    };
    expect(serializeExpandedLinkGraphEntry(wikiEmpty)).toBe(
      '{"candidates":[],"kind":"wiki","ordinal":3,"status":"unresolved"}',
    );
  });

  it("measures entries exactly (JSON.stringify + UTF-8 ground truth)", () => {
    const entries: readonly ExpandedLinkGraphEntry[] = [
      {
        kind: "standard",
        status: "resolved",
        candidates: ["a/b.md"],
        ordinal: 1,
      },
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
      expect(measureExpandedLinkGraphEntryBytes(entry)).toBe(
        groundTruthBytes(serializeExpandedLinkGraphEntry(entry)),
      );
    }
    const whole = `[${entries.map(serializeExpandedLinkGraphEntry).join(",")}]`;
    expect(measureExpandedLinkGraphBytes(entries)).toBe(
      groundTruthBytes(whole),
    );
  });

  it("charges astral candidates as 4 UTF-8 bytes per code point", () => {
    const entry: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["v/😀.md"],
      ordinal: 1,
    };
    expect(serializeExpandedLinkGraphEntry(entry)).toBe(
      '{"candidates":["v/😀.md"],"kind":"standard","ordinal":1,"status":"resolved"}',
    );
    // `v/😀.md`: v(1) /(1) 😀(4) .(1) m(1) d(1) = 9 + 2 quotes = 11.
    expect(groundTruthBytes(JSON.stringify("v/😀.md"))).toBe(11);
    expect(measureExpandedLinkGraphEntryBytes(entry)).toBe(
      groundTruthBytes(serializeExpandedLinkGraphEntry(entry)),
    );
    expect(utf8ByteLength(serializeExpandedLinkGraphEntry(entry))).toBe(
      groundTruthBytes(serializeExpandedLinkGraphEntry(entry)),
    );
  });

  it("charges quote/backslash escapes exactly (JSON escaping only grows output)", () => {
    const candidate = 'v/a"b\\c.md';
    const json = JSON.stringify(candidate);
    expect(json).toBe('"v/a\\"b\\\\c.md"');
    expect(groundTruthBytes(json)).toBeGreaterThan(candidate.length + 2);
    const entry: ExpandedLinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: [candidate, "v/plain.md"],
      ordinal: 7,
    };
    expect(measureExpandedLinkGraphEntryBytes(entry)).toBe(
      groundTruthBytes(serializeExpandedLinkGraphEntry(entry)),
    );
  });

  it("keeps the incremental budget identical to the whole-graph measure", () => {
    const entries: readonly ExpandedLinkGraphEntry[] = [
      {
        kind: "standard",
        status: "resolved",
        candidates: ["a/b.md"],
        ordinal: 1,
      },
      {
        kind: "wiki",
        status: "ambiguous",
        candidates: ["v/a/Note.md", "v/b/Note.md"],
        ordinal: 2,
      },
      { kind: "standard", status: "unresolved", candidates: [], ordinal: 3 },
      { kind: "wiki", status: "resolved", candidates: ["v/😀.md"], ordinal: 4 },
    ];
    const budget = createExpandedLinkGraphBudget();
    const accepted: ExpandedLinkGraphEntry[] = [];
    for (const entry of entries) {
      expect(budget.tryAddEntry(entry)).toBe(true);
      accepted.push(entry);
      expect(budget.bytes).toBe(measureExpandedLinkGraphBytes(accepted));
      expect(budget.count).toBe(accepted.length);
    }
  });

  it("charges repeated candidates per occurrence and unresolved entries too", () => {
    const entry: ExpandedLinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: ["v/a/Note.md", "v/b/Note.md"],
      ordinal: 1,
    };
    const once = createExpandedLinkGraphBudget();
    expect(once.tryAddEntry(entry)).toBe(true);
    const twice = createExpandedLinkGraphBudget();
    expect(twice.tryAddEntry(entry)).toBe(true);
    // Same candidate repeated: no dedup across entries, charged twice.
    expect(twice.tryAddEntry({ ...entry, ordinal: 2 })).toBe(true);
    expect(twice.bytes).toBe(
      measureExpandedLinkGraphBytes([entry, { ...entry, ordinal: 2 }]),
    );
    expect(twice.bytes).toBeGreaterThan(once.bytes);
    expect(twice.count).toBe(2);
    // Unresolved entries (empty candidates) still consume framing bytes.
    const empty = createExpandedLinkGraphBudget();
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
    const probe: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: [""],
      ordinal: 1,
    };
    const staticOverhead = measureExpandedLinkGraphEntryBytes(probe) - 2;
    const fillLength = CAP - 2 - staticOverhead - 2;
    expect(fillLength).toBeGreaterThan(0);
    const exact: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(fillLength)],
      ordinal: 1,
    };
    expect(measureExpandedLinkGraphBytes([exact])).toBe(CAP);
    const ok = createExpandedLinkGraphBudget();
    expect(ok.tryAddEntry(exact)).toBe(true);
    expect(ok.bytes).toBe(CAP);
    expect(ok.count).toBe(1);
    const over: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(fillLength + 1)],
      ordinal: 1,
    };
    expect(measureExpandedLinkGraphBytes([over])).toBe(CAP + 1);
    const denied = createExpandedLinkGraphBudget();
    expect(denied.tryAddEntry(over)).toBe(false);
    expect(denied.bytes).toBe(2);
    expect(denied.count).toBe(0);
  });

  it("accepts a multi-entry graph at exactly 262144 then rejects the next entry", () => {
    const budget = createExpandedLinkGraphBudget();
    const accepted: ExpandedLinkGraphEntry[] = [];
    // Fixed head of small entries (well below cap), then one crafted ascii
    // tail candidate lands the total at exactly the cap.
    for (let index = 0; index < 100; index += 1) {
      const entry: ExpandedLinkGraphEntry = {
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
    const tailProbe: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: [""],
      ordinal: accepted.length + 1,
    };
    const overhead = measureExpandedLinkGraphEntryBytes(tailProbe) - 2;
    const length = remaining - overhead - 2;
    expect(length).toBeGreaterThan(0);
    const tail: ExpandedLinkGraphEntry = {
      kind: "standard",
      status: "resolved",
      candidates: ["a".repeat(length)],
      ordinal: accepted.length + 1,
    };
    expect(budget.tryAddEntry(tail)).toBe(true);
    accepted.push(tail);
    expect(budget.bytes).toBe(CAP);
    expect(budget.bytes).toBe(measureExpandedLinkGraphBytes(accepted));
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

  it("counts candidates incrementally (no huge serialization before the check)", () => {
    const budget = createExpandedLinkGraphBudget();
    const huge: ExpandedLinkGraphEntry = {
      kind: "wiki",
      status: "ambiguous",
      candidates: Array.from({ length: 20_000 }, (_, i) => `v/d${i}/Note.md`),
      ordinal: 1,
    };
    expect(measureExpandedLinkGraphBytes([huge])).toBeGreaterThan(CAP);
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
