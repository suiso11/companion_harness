import type { CallResult } from "@companion/connector-mcp";
import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  normalizeEvent,
  normalizeGetResult,
  normalizeSearchResult,
} from "../src/normalize.js";
import { calendarSearchInputSchema } from "../src/searchInput.js";

/**
 * Retained C08 archive bodies (candidate `97a3dc36…`, synthetic fixture
 * provider) — consumer test material only, NOT fresh upstream evidence and NOT
 * an adoption claim. `structuredContent` was ABSENT on every retained call, so
 * these bodies are the JSON content text.
 */
const RETAINED_TIMED_EVENT = {
  id: "fixture-event",
  etag: '"opaque-etag-timed"',
  summary: "Fixture Timed Event",
  description: "fixture-description-sentinel",
  location: "fixture-location-sentinel",
  start: { dateTime: "2026-10-01T09:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-10-01T10:00:00Z", timeZone: "UTC" },
  startDayOfWeek: "Thursday",
  endDayOfWeek: "Thursday",
  status: "confirmed",
  htmlLink: "https://example.invalid/calendar/event?eid=opaque-not-secret",
  created: "2026-09-30T12:00:00.000Z",
  updated: "2026-10-01T12:00:00.000Z",
  organizer: { email: "fixture-organizer@example.invalid", self: true },
  attendees: [
    {
      email: "fixture-attendee@example.invalid",
      displayName: "Fixture Attendee",
      responseStatus: "accepted",
    },
  ],
  transparency: "opaque",
  visibility: "private",
  conferenceData: {
    conferenceId: "opaque-conference-id",
    entryPoints: [
      {
        entryPointType: "video",
        uri: "https://meet.example.invalid/opaque-not-secret",
      },
    ],
  },
  extendedProperties: { private: { fixtureKey: "opaque-not-secret" } },
  hangoutLink: "https://meet.example.invalid/opaque-not-secret",
  calendarId: "fixture@example.invalid",
  accountId: "fixture",
};

const RETAINED_ALL_DAY_EVENT = {
  id: "fixture-event-allday",
  etag: '"opaque-etag-allday"',
  summary: "Fixture All-Day Event",
  start: { date: "2026-10-02" },
  end: { date: "2026-10-03" },
  startDayOfWeek: "Friday",
  endDayOfWeek: "Saturday",
  status: "tentative",
  htmlLink: "https://example.invalid/calendar/event?eid=opaque-not-secret-2",
  updated: "2026-10-01T13:00:00.000Z",
  calendarId: "fixture@example.invalid",
  accountId: "fixture",
};

const RETAINED_LIST_BODY = {
  events: [RETAINED_TIMED_EVENT, RETAINED_ALL_DAY_EVENT],
  totalCount: 2,
  nextPageToken: "opaque-out",
};

const RETAINED_SEARCH_BODY = {
  events: [RETAINED_TIMED_EVENT, RETAINED_ALL_DAY_EVENT],
  totalCount: 2,
  query: "fixture",
  calendarId: "fixture@example.invalid",
  nextPageToken: "opaque-out",
  timeRange: {
    start: "2026-10-01T00:00:00Z",
    end: "2026-10-02T00:00:00Z",
  },
};

const RETAINED_GET_BODY = { event: RETAINED_TIMED_EVENT };

const LIST_OPTIONS = {
  connectorInstanceId: "cal-1",
  calendarId: "fixture@example.invalid",
  requestedLimit: 10,
  operation: "list-events" as const,
};

const SEARCH_OPTIONS = { ...LIST_OPTIONS, operation: "search-events" as const };

function textResult(body: unknown): CallResult {
  return { ok: true, text: JSON.stringify(body) };
}

function structuredResult(body: unknown): CallResult {
  return { ok: true, structuredContent: body };
}

function timedEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "e1",
    calendarId: "primary",
    status: "confirmed",
    summary: "T",
    start: { dateTime: "2026-09-10T09:00:00Z" },
    end: { dateTime: "2026-09-10T09:30:00Z" },
    ...overrides,
  };
}

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

  it("uses elapsed instants for the exact 90d boundary (+1ms rejects)", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-01-01T00:00:00Z",
        end: "2026-04-01T00:00:00Z",
      }),
    ).not.toThrow();
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-01-01T00:00:00Z",
        end: "2026-04-01T00:00:00.001Z",
      }),
    ).toThrow();
  });

  it("counts elapsed time across a DST transition, not local days", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-03-08T01:30:00-05:00",
        end: "2026-03-08T03:30:00-04:00",
      }),
    ).not.toThrow();
  });

  it("rejects naive, impossible and offset-less datetimes", () => {
    for (const bad of [
      { start: "2026-09-10T09:00:00", end: "2026-09-10T10:00:00Z" },
      { start: "2026-02-30T09:00:00Z", end: "2026-03-01T00:00:00Z" },
      { start: "2026-09-10 09:00:00Z", end: "2026-09-10T10:00:00Z" },
      { start: "2026-09-10", end: "2026-09-11" },
      { start: "2026-09-10T09:00:00+25:00", end: "2026-09-10T10:00:00Z" },
    ]) {
      expect(() => calendarSearchInputSchema.parse(bad)).toThrow();
    }
  });

  it("keeps the agreed fractional-second precision", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T09:00:00.250Z",
        end: "2026-09-10T09:00:00.750Z",
      }),
    ).not.toThrow();
  });

  it("accepts a year-0 leap-day range and rejects genuine sub-ms fractions (shared contract)", () => {
    const leapDay = calendarSearchInputSchema.parse({
      start: "0000-02-29T23:00:00Z",
      end: "0000-03-01T01:00:00Z",
    });
    expect(leapDay.start).toBe("0000-02-29T23:00:00Z");
    // Shared strict-instant contract (B2/C10-08): a nonzero digit past the
    // millisecond position is genuine sub-ms precision — REJECTED, never
    // silently truncated to `.999` (the old truncating behavior is gone).
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T09:00:00.1234Z",
        end: "2026-09-10T09:00:01Z",
      }),
    ).toThrow();
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T09:00:00.999999999999999999Z",
        end: "2026-09-10T09:00:01Z",
      }),
    ).toThrow();
    // Millisecond-expressible fractions (same instants, trailing zeros) stay.
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T09:00:00.123000Z",
        end: "2026-09-10T09:00:01Z",
      }),
    ).not.toThrow();
  });

  it("bounds the cursor and rejects unknown keys", () => {
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T00:00:00Z",
        end: "2026-09-11T00:00:00Z",
        cursor: "x".repeat(2048),
      }),
    ).not.toThrow();
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T00:00:00Z",
        end: "2026-09-11T00:00:00Z",
        cursor: "x".repeat(2049),
      }),
    ).toThrow();
    expect(() =>
      calendarSearchInputSchema.parse({
        start: "2026-09-10T00:00:00Z",
        end: "2026-09-11T00:00:00Z",
        maxResults: 10,
      }),
    ).toThrow();
  });
});

describe("normalizeEvent (retained nested candidate shape)", () => {
  it("drops the 7 privacy fields plus unknown extras and keeps the canonical key", async () => {
    const raw = {
      ...RETAINED_TIMED_EVENT,
      creator: { email: "fixture-creator@example.invalid" },
      recurrence: ["RRULE:FREQ=DAILY"],
      source: { url: "https://source.example.invalid/opaque" },
      attachments: [{ fileUrl: "https://file.example.invalid/opaque" }],
    };
    const out = await normalizeEvent(raw, { connectorInstanceId: "cal-1" });
    expect(out.canonicalKey).toBe(
      await canonicalKey("cal-1", "fixture@example.invalid", "fixture-event"),
    );
    expect(out.revisionBasis).toBe("etag");
    expect(out.sourceRevision).toBe('"opaque-etag-timed"');
    expect(out.sensitivity).toBe("personal");
    for (const field of [
      "creator",
      "attendees",
      "organizer",
      "conferenceData",
      "hangoutLink",
      "htmlLink",
      "extendedProperties",
      "accountId",
      "startDayOfWeek",
      "endDayOfWeek",
      "created",
      "transparency",
      "visibility",
      "recurrence",
      "source",
      "attachments",
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it("disambiguates colon-joined tuples with a bounded opaque key", async () => {
    const a = await canonicalKey("a", "b:c", "d");
    const b = await canonicalKey("a:b", "c", "d");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^calendar:[0-9a-f]{64}$/);
    expect(b).toMatch(/^calendar:[0-9a-f]{64}$/);
  });

  it("keeps all-day DATE endpoints unchanged and end exclusive", async () => {
    const out = await normalizeEvent(RETAINED_ALL_DAY_EVENT, {
      connectorInstanceId: "cal-1",
    });
    expect(out.allDayEndExclusive).toBe(true);
    expect(out.start).toBe("2026-10-02");
    expect(out.end).toBe("2026-10-03");
  });

  it("canonicalizes timed instants to UTC and normalizes equal instants equally", async () => {
    const a = await normalizeEvent(
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00+09:00" },
        end: { dateTime: "2026-09-10T09:30:00+09:00" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    const b = await normalizeEvent(
      timedEvent({
        start: { dateTime: "2026-09-10T00:00:00Z" },
        end: { dateTime: "2026-09-10T00:30:00Z" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(a.start).toBe("2026-09-10T00:00:00.000Z");
    expect(a.end).toBe("2026-09-10T00:30:00.000Z");
    expect(a.start).toBe(b.start);
    expect(a.end).toBe(b.end);
    expect(a.sourceRevision).toBe(b.sourceRevision);
  });

  it("validates early years without the Date.UTC 0..99 rollover trap", async () => {
    const out = await normalizeEvent(
      timedEvent({
        start: { date: "0099-12-31" },
        end: { date: "0100-01-01" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(out.allDayEndExclusive).toBe(true);
    expect(out.start).toBe("0099-12-31");
    const early = await normalizeEvent(
      timedEvent({
        start: { date: "0001-01-01" },
        end: { date: "0001-01-02" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(early.allDayEndExclusive).toBe(true);
  });

  it("accepts the year-0 leap day and canonicalizes its timed instants", async () => {
    const allDay = await normalizeEvent(
      timedEvent({
        start: { date: "0000-02-29" },
        end: { date: "0000-03-01" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(allDay.allDayEndExclusive).toBe(true);
    expect(allDay.start).toBe("0000-02-29");
    expect(allDay.end).toBe("0000-03-01");

    const leap = await normalizeEvent(
      timedEvent({
        start: { dateTime: "0000-02-29T00:00:00Z" },
        end: { dateTime: "0000-02-29T01:00:00Z" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(leap.start).toBe("0000-02-29T00:00:00.000Z");
    expect(leap.end).toBe("0000-02-29T01:00:00.000Z");

    const offset = await normalizeEvent(
      timedEvent({
        start: { dateTime: "0000-02-29T00:00:00+01:00" },
        end: { dateTime: "0000-02-29T01:00:00Z" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(offset.start).toBe("0000-02-28T23:00:00.000Z");
  });

  it("rejects a long genuine sub-ms fraction (shared contract) but keeps ms-expressible precision in its own second", async () => {
    // Shared strict-instant contract (B2/C10-08): `.9999999…` names genuine
    // sub-millisecond precision — REJECTED (`calendar_response_invalid`),
    // never truncated to `.999` as before.
    const long = "2026-09-10T09:00:00.999999999999999999Z";
    await expect(
      normalizeEvent(
        timedEvent({
          start: { dateTime: long },
          end: { dateTime: "2026-09-10T09:00:01Z" },
        }),
        { connectorInstanceId: "cal-1" },
      ),
    ).rejects.toThrow("calendar_response_invalid");

    const short = await normalizeEvent(
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00.999Z" },
        end: { dateTime: "2026-09-10T10:00:00Z" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    // Same instant, millisecond-expressible with a trailing-zero tail.
    const same = await normalizeEvent(
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00.999000Z" },
        end: { dateTime: "2026-09-10T10:00:00Z" },
      }),
      { connectorInstanceId: "cal-1" },
    );
    expect(short.start).toBe("2026-09-10T09:00:00.999Z");
    expect(short.start).toBe(same.start);
    expect(short.sourceRevision).toBe(same.sourceRevision);
  });

  it("rejects bad endpoints, mixed kinds, both variants and invalid IANA/offsets", async () => {
    const bad: unknown[] = [
      timedEvent({
        start: { dateTime: "2026-09-10T10:00:00Z" },
        end: { dateTime: "2026-09-10T09:00:00Z" },
      }),
      timedEvent({
        start: { date: "2026-09-10" },
        end: { dateTime: "2026-09-10T09:30:00Z" },
      }),
      timedEvent({
        start: { date: "2026-02-30" },
        end: { date: "2026-03-01" },
      }),
      timedEvent({
        start: { dateTime: "2026-02-30T09:00:00Z" },
        end: { dateTime: "2026-03-01T09:00:00Z" },
      }),
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00" },
        end: { dateTime: "2026-09-10T09:30:00Z" },
      }),
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00Z", timeZone: "Not/AZone" },
        end: { dateTime: "2026-09-10T09:30:00Z" },
      }),
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00Z", timeZone: "+09:00" },
        end: { dateTime: "2026-09-10T09:30:00Z" },
      }),
      timedEvent({
        start: { date: "2026-09-10", dateTime: "2026-09-10T09:00:00Z" },
        end: { date: "2026-09-11" },
      }),
      timedEvent({ start: {}, end: { dateTime: "2026-09-10T09:30:00Z" } }),
      timedEvent({
        start: { dateTime: "2026-09-10T09:00:00+25:00" },
        end: { dateTime: "2026-09-10T09:30:00Z" },
      }),
    ];
    for (const raw of bad) {
      await expect(
        normalizeEvent(raw, { connectorInstanceId: "cal-1" }),
      ).rejects.toThrow("calendar_response_invalid");
    }
  });

  it("never fabricates a title or confirmed status for missing consumed fields", async () => {
    await expect(
      normalizeEvent(
        { calendarId: "primary", status: "confirmed", start: {}, end: {} },
        { connectorInstanceId: "cal-1" },
      ),
    ).rejects.toThrow("calendar_response_invalid");
    await expect(
      normalizeEvent(
        { id: "e", calendarId: "primary", summary: "T", start: {}, end: {} },
        { connectorInstanceId: "cal-1" },
      ),
    ).rejects.toThrow("calendar_response_invalid");
  });

  it("rejects with a fixed error that carries no cause or raw value", async () => {
    let caught: unknown;
    try {
      await normalizeEvent(
        { id: "", calendarId: "primary", status: "bogus", summary: "" },
        { connectorInstanceId: "cal-1" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("calendar_response_invalid");
    expect((caught as Error).cause).toBeUndefined();
  });
});

describe("revision precedence and normalized-snapshot hash", () => {
  const base = {
    id: "e5",
    calendarId: "primary",
    status: "confirmed",
    summary: "T",
    start: { dateTime: "2026-09-10T09:00:00Z" },
    end: { dateTime: "2026-09-10T09:30:00Z" },
  };

  it("prefers etag over canonical updated over normalized hash", async () => {
    const etag = await normalizeEvent(
      { ...base, etag: '"abc"', updated: "2026-09-08T01:02:03+09:00" },
      { connectorInstanceId: "cal-1" },
    );
    expect(etag.revisionBasis).toBe("etag");
    expect(etag.sourceRevision).toBe('"abc"');
    expect(etag.sourceUpdatedAt).toBe("2026-09-07T16:02:03.000Z");

    const updated = await normalizeEvent(
      { ...base, updated: "2026-09-08T01:02:03+09:00" },
      { connectorInstanceId: "cal-1" },
    );
    expect(updated.revisionBasis).toBe("source-updated");
    expect(updated.sourceRevision).toBe("2026-09-07T16:02:03.000Z");

    const hashed = await normalizeEvent(base, { connectorInstanceId: "cal-1" });
    expect(hashed.revisionBasis).toBe("normalized-hash");
    expect(hashed.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates updated even when etag wins", async () => {
    await expect(
      normalizeEvent(
        { ...base, etag: '"abc"', updated: "2026-02-30T00:00:00Z" },
        { connectorInstanceId: "cal-1" },
      ),
    ).rejects.toThrow("calendar_response_invalid");
  });

  it("hashes the truncated normalized snapshot, not the raw source", async () => {
    const long = "x".repeat(9000);
    const a = await normalizeEvent(
      { ...base, description: `${long}AAA-tail` },
      { connectorInstanceId: "cal-1" },
    );
    const b = await normalizeEvent(
      { ...base, description: `${long}BBB-tail` },
      { connectorInstanceId: "cal-1" },
    );
    expect(a.revisionBasis).toBe("normalized-hash");
    expect(a.sourceRevision).toBe(b.sourceRevision);
    expect(Array.from(String(a.description)).length).toBe(8192);
  });

  it("distinguishes status, start/end and absent-versus-empty description", async () => {
    const confirmed = await normalizeEvent(base, {
      connectorInstanceId: "cal-1",
    });
    const cancelled = await normalizeEvent(
      { ...base, status: "cancelled" },
      { connectorInstanceId: "cal-1" },
    );
    const moved = await normalizeEvent(
      {
        ...base,
        start: { dateTime: "2026-09-11T09:00:00Z" },
        end: { dateTime: "2026-09-11T09:30:00Z" },
      },
      { connectorInstanceId: "cal-1" },
    );
    const absent = await normalizeEvent(base, { connectorInstanceId: "cal-1" });
    const empty = await normalizeEvent(
      { ...base, description: "" },
      { connectorInstanceId: "cal-1" },
    );
    expect(confirmed.sourceRevision).not.toBe(cancelled.sourceRevision);
    expect(confirmed.sourceRevision).not.toBe(moved.sourceRevision);
    expect(absent.sourceRevision).not.toBe(empty.sourceRevision);
  });
});

describe("normalizeSearchResult / normalizeGetResult (structured-first)", () => {
  it("accepts the retained structured page with an opaque verbatim cursor", async () => {
    const out = await normalizeSearchResult(
      structuredResult(RETAINED_LIST_BODY),
      LIST_OPTIONS,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events).toHaveLength(2);
    expect(out.cursor).toBe("opaque-out");
  });

  it("accepts the retained whole-text JSON page when structuredContent is absent", async () => {
    const out = await normalizeSearchResult(
      textResult(RETAINED_SEARCH_BODY),
      SEARCH_OPTIONS,
    );
    expect(out.ok).toBe(true);
  });

  it("accepts the retained get envelope and rejects pages", async () => {
    const out = await normalizeGetResult(structuredResult(RETAINED_GET_BODY), {
      connectorInstanceId: "cal-1",
      calendarId: "fixture@example.invalid",
    });
    expect(out.ok).toBe(true);
    const pageAsGet = await normalizeGetResult(
      structuredResult(RETAINED_LIST_BODY),
      {
        connectorInstanceId: "cal-1",
        calendarId: "fixture@example.invalid",
      },
    );
    expect(pageAsGet).toEqual({ ok: false, code: "calendar_response_invalid" });
    const getAsPage = await normalizeSearchResult(
      structuredResult(RETAINED_GET_BODY),
      LIST_OPTIONS,
    );
    expect(getAsPage).toEqual({ ok: false, code: "calendar_response_invalid" });
  });

  it("structuredContent present is the ONLY source, even with malformed text", async () => {
    const result = {
      ok: true as const,
      structuredContent: RETAINED_LIST_BODY,
      text: "not json at all",
    };
    const out = await normalizeSearchResult(result, LIST_OPTIONS);
    expect(out.ok).toBe(true);
  });

  it("present null/undefined/wrong-shaped structuredContent is never rescued by text", async () => {
    const validText = JSON.stringify(RETAINED_LIST_BODY);
    const presentNull = {
      ok: true as const,
      structuredContent: null,
      text: validText,
    };
    const presentUndefined = {
      ok: true as const,
      structuredContent: undefined,
      text: validText,
    } as unknown as CallResult;
    const wrongShape = {
      ok: true as const,
      structuredContent: { wrong: true },
      text: validText,
    };
    for (const result of [presentNull, presentUndefined, wrongShape]) {
      expect(await normalizeSearchResult(result, LIST_OPTIONS)).toEqual({
        ok: false,
        code: "calendar_response_invalid",
      });
    }
  });

  it("rejects prose, fenced and trailing JSON text", async () => {
    const good = JSON.stringify(RETAINED_LIST_BODY);
    for (const text of [
      `here is the page: ${good}`,
      `\`\`\`json\n${good}\n\`\`\``,
      `${good} trailing`,
      "not json",
    ]) {
      const out = await normalizeSearchResult(
        { ok: true as const, text },
        LIST_OPTIONS,
      );
      expect(out).toEqual({ ok: false, code: "calendar_response_invalid" });
    }
  });

  it("rejects page-length mismatches, over-limit pages and cross-calendar ids", async () => {
    const events = Array.from({ length: 11 }, (_, i) => ({
      ...RETAINED_TIMED_EVENT,
      id: `fixture-event-${i}`,
    }));
    const overLimit = {
      ...RETAINED_LIST_BODY,
      events,
      totalCount: events.length,
    };
    expect(
      await normalizeSearchResult(structuredResult(overLimit), LIST_OPTIONS),
    ).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });

    const mismatched = { ...RETAINED_LIST_BODY, totalCount: 99 };
    expect(
      await normalizeSearchResult(structuredResult(mismatched), LIST_OPTIONS),
    ).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });

    const crossCalendar = {
      ...RETAINED_LIST_BODY,
      events: [
        { ...RETAINED_TIMED_EVENT, calendarId: "other@example.invalid" },
        RETAINED_ALL_DAY_EVENT,
      ],
    };
    expect(
      await normalizeSearchResult(
        structuredResult(crossCalendar),
        LIST_OPTIONS,
      ),
    ).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });

    const rootMismatch = {
      ...RETAINED_SEARCH_BODY,
      calendarId: "other@example.invalid",
    };
    expect(
      await normalizeSearchResult(
        structuredResult(rootMismatch),
        SEARCH_OPTIONS,
      ),
    ).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });
  });

  it("rejects invalid cursor shapes and unknown root fields", async () => {
    for (const token of ["", "x".repeat(2049), 42, { token: "x" }]) {
      const body = { ...RETAINED_LIST_BODY, nextPageToken: token };
      expect(
        await normalizeSearchResult(structuredResult(body), LIST_OPTIONS),
      ).toEqual({
        ok: false,
        code: "calendar_response_invalid",
      });
    }
    const unknownRoot = { ...RETAINED_LIST_BODY, unexpected: true };
    expect(
      await normalizeSearchResult(structuredResult(unknownRoot), LIST_OPTIONS),
    ).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });
  });

  it("validates HOST page options", async () => {
    expect(
      await normalizeSearchResult(structuredResult(RETAINED_LIST_BODY), {
        ...LIST_OPTIONS,
        requestedLimit: 0,
      }),
    ).toEqual({ ok: false, code: "calendar_range_invalid" });
    expect(
      await normalizeSearchResult(structuredResult(RETAINED_LIST_BODY), {
        ...LIST_OPTIONS,
        calendarId: "",
      }),
    ).toEqual({ ok: false, code: "calendar_range_invalid" });
  });
});
