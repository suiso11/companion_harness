import { describe, expect, it } from "vitest";
import spike from "../spike/proposed-binding.fixture.json" with {
  type: "json",
};
import { PROPOSED_BINDING } from "../src/binding.js";
import {
  canonicalKey,
  classifyDeletion,
  normalizeEvent,
} from "../src/normalize.js";
import { calendarSearchInputSchema } from "../src/searchInput.js";

const page1 = (
  spike as unknown as {
    listEventsPage1: { events: Array<Record<string, unknown>> };
  }
).listEventsPage1;

describe("calendar.search input (§17.4 exact)", () => {
  it("accepts a bounded range with defaults", () => {
    const parsed = calendarSearchInputSchema.parse({
      start: "2026-09-10T00:00:00+09:00",
      end: "2026-09-17T00:00:00+09:00",
    });
    expect(parsed.limit).toBe(10);
  });

  it("rejects start>=end and ranges over 90 days", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-17T00:00:00+09:00",
        end: "2026-09-10T00:00:00+09:00",
      }),
    ).toThrow();
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-01-01T00:00:00Z",
        end: "2026-06-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("caps limit at 20 (one page per call)", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T00:00:00+09:00",
        end: "2026-09-11T00:00:00+09:00",
        limit: 21,
      }),
    ).toThrow();
  });
});

describe("normalize (spike fixture, proposed fork shape only)", () => {
  it("drops privacy passthrough fields and keeps canonical key", async () => {
    const raw = page1.events[0] as Record<string, unknown>;
    const out = await normalizeEvent(raw, {
      connectorInstanceId: "cal-1",
      nowIso: "2026-09-08T00:00:00Z",
    });
    expect(out.canonicalKey).toBe(canonicalKey("cal-1", "primary", "evt_123"));
    expect(out.revisionBasis).toBe("etag");
    expect(out.sourceRevision).toBe('"abc123"');
    expect(out).not.toHaveProperty("attendees");
    expect(out).not.toHaveProperty("organizer");
    expect(out).not.toHaveProperty("hangoutLink");
    expect(out).not.toHaveProperty("htmlLink");
  });

  it("falls back to content hash without etag/updated", async () => {
    const raw = {
      id: "e1",
      calendarId: "primary",
      status: "confirmed",
      summary: "No rev",
      start: "2026-09-10T09:00:00+09:00",
      end: "2026-09-10T09:30:00+09:00",
    };
    const out = await normalizeEvent(raw, {
      connectorInstanceId: "cal-1",
      nowIso: "2026-09-08T00:00:00Z",
    });
    expect(out.revisionBasis).toBe("normalized-hash");
    expect(out.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deletion classifier (no tombstone from omission)", () => {
  it("search omission never deletes", () => {
    expect(
      classifyDeletion({
        priorKnown: true,
        authoritativeRead: "search-omission",
      }),
    ).toEqual({ kind: "not-deleted", reason: "no-authoritative-evidence" });
  });

  it("only operation-specific tombstones delete", () => {
    expect(
      classifyDeletion({
        priorKnown: true,
        authoritativeRead: "get-tombstone",
      }),
    ).toEqual({ kind: "deleted", reason: "authoritative-tombstone" });
    expect(
      classifyDeletion({ priorKnown: true, authoritativeRead: "not-found" }),
    ).toEqual({ kind: "not-deleted", reason: "no-authoritative-evidence" });
    expect(
      classifyDeletion({
        priorKnown: true,
        authoritativeRead: "ambiguous-error",
      }),
    ).toEqual({ kind: "unknown", code: "calendar_upstream_error" });
  });
});

describe("event time validation + normalized-snapshot hash (§17.4)", () => {
  it("accepts all-day DATE ranges with exclusive end", async () => {
    const out = await normalizeEvent(
      {
        id: "e2",
        calendarId: "primary",
        status: "confirmed",
        summary: "Holiday",
        start: "2026-09-10",
        end: "2026-09-11",
      },
      { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
    );
    expect(out.allDayEndExclusive).toBe(true);
  });

  it("rejects end<=start, invalid ISO, and invalid all-day dates", async () => {
    const base = {
      id: "e3",
      calendarId: "primary",
      status: "confirmed",
      summary: "Bad",
    };
    await expect(
      normalizeEvent(
        {
          ...base,
          start: "2026-09-10T10:00:00+09:00",
          end: "2026-09-10T09:00:00+09:00",
        },
        { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
      ),
    ).rejects.toThrow();
    await expect(
      normalizeEvent(
        { ...base, start: "not-a-time", end: "2026-09-10T09:00:00+09:00" },
        { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
      ),
    ).rejects.toThrow();
    await expect(
      normalizeEvent(
        { ...base, start: "2026-02-30", end: "2026-03-01" },
        { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
      ),
    ).rejects.toThrow();
  });

  it("hashes the truncated normalized snapshot, not the raw source", async () => {
    const long = "x".repeat(9000);
    const a = await normalizeEvent(
      {
        id: "e4",
        calendarId: "primary",
        status: "confirmed",
        summary: "T",
        description: `${long}AAA-tail`,
        start: "2026-09-10T09:00:00+09:00",
        end: "2026-09-10T09:30:00+09:00",
      },
      { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
    );
    const b = await normalizeEvent(
      {
        id: "e4",
        calendarId: "primary",
        status: "confirmed",
        summary: "T",
        description: `${long}BBB-tail`,
        start: "2026-09-10T09:00:00+09:00",
        end: "2026-09-10T09:30:00+09:00",
      },
      { connectorInstanceId: "cal-1", nowIso: "2026-09-08T00:00:00Z" },
    );
    // Both descriptions truncate to the same 8192-char snapshot prefix, so
    // the snapshot hash must be identical (a raw-source hash would differ).
    expect(a.revisionBasis).toBe("normalized-hash");
    expect(a.sourceRevision).toBe(b.sourceRevision);
  });
});

describe("proposed binding identity (NOT upstream compat)", () => {
  it("pins the single model tool and four internal operations", () => {
    expect(PROPOSED_BINDING.modelTool).toBe("calendar.search");
    expect([...PROPOSED_BINDING.connectorOperations]).toEqual([
      "list-calendars",
      "list-events",
      "search-events",
      "get-event",
    ]);
  });
});
