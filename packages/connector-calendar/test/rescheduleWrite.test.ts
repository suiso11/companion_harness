// M5 dedicated reschedule write path: SELF-CONTAINED behavior tests.
//
// No imports from any ignored nested checkout: the fixture HTTP server AND
// HTTP server AND the test-local Google-shaped wire provider are DEFINED
// HERE (fixtures belong to tests). They exercise the REAL Harness port
// (`createRescheduleWritePort`) against a REAL loopback fixture with
// Google-shape events + exact-etag If-Match semantics, single PATCH,
// no retry. No live Google, no OAuth, fixture data only.
//
// A separate real-process suite (`rescheduleProcess.test.ts`) drives a REAL
// child-process MCP server over stdio MCP into the same Google-shaped
// fixture (tracked fixture server by default; the real fork bundle via
// explicit `M5_RESCHEDULE_FORK_CLI`); this file covers the port-level
// closed outcomes.

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRescheduleWritePort,
  isSourceEtagBasis,
  type RescheduleWriteCaller,
} from "../src/rescheduleWrite.js";

type FixtureEventRecord = {
  etag: string;
  status: "confirmed" | "tentative" | "cancelled" | "deleted";
  start: string;
  end: string;
  recurring: boolean;
  allDay: boolean;
};

type StoredEvent = FixtureEventRecord & {
  patchCount: number;
  wireStartOverride?: unknown;
  wireEndOverride?: unknown;
};

const CALENDAR_ID = "primary";
const EVENT_ID = "evt-timed-1";
const ETAG_V1 = '"etag-v1"';
const START_NEW = "2026-03-01T10:00:00Z";
const END_NEW = "2026-03-01T11:00:00Z";

let server: Server | undefined;
let baseUrl = "";
let store: Map<string, StoredEvent>;
let lastPatch: {
  headers: Record<string, string | undefined>;
  body: string;
} | null;

function key(calendarId: string, eventId: string): string {
  return `${calendarId}/${eventId}`;
}

function freshStore(): Map<string, StoredEvent> {
  return new Map([
    [
      key(CALENDAR_ID, EVENT_ID),
      {
        etag: ETAG_V1,
        status: "confirmed",
        start: "2026-02-01T10:00:00Z",
        end: "2026-02-01T11:00:00Z",
        recurring: false,
        allDay: false,
        patchCount: 0,
      },
    ],
  ]);
}

function toGoogleBody(record: StoredEvent): unknown {
  const start =
    record.wireStartOverride !== undefined
      ? record.wireStartOverride
      : record.allDay
        ? { date: "2026-02-01" }
        : { dateTime: record.start };
  const end =
    record.wireEndOverride !== undefined
      ? record.wireEndOverride
      : record.allDay
        ? { date: "2026-02-02" }
        : { dateTime: record.end };
  return {
    id: EVENT_ID,
    etag: record.etag,
    status: record.status,
    start,
    end,
    ...(record.recurring ? { recurrence: ["RRULE:FREQ=DAILY"] } : {}),
  };
}

async function startFixture(): Promise<string> {
  store = freshStore();
  lastPatch = null;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/events\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    const id = `${decodeURIComponent(match[1] as string)}/${decodeURIComponent(match[2] as string)}`;
    if (req.method === "GET") {
      const record = store.get(id);
      if (record === undefined) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(toGoogleBody(record)));
      return;
    }
    if (req.method === "PATCH") {
      const record = store.get(id);
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        lastPatch = {
          headers: {
            "if-match": req.headers["if-match"] as string | undefined,
            "content-type": req.headers["content-type"] as string | undefined,
          },
          body: raw,
        };
        if (record === undefined) {
          res.writeHead(404).end();
          return;
        }
        if (req.headers["if-match"] !== record.etag) {
          res.writeHead(412).end();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const patch = parsed as { start?: unknown; end?: unknown };
        const startObj =
          typeof patch.start === "object" && patch.start !== null
            ? (patch.start as Record<string, unknown>)
            : undefined;
        const endObj =
          typeof patch.end === "object" && patch.end !== null
            ? (patch.end as Record<string, unknown>)
            : undefined;
        const startDt = startObj?.dateTime;
        const endDt = endObj?.dateTime;
        if (typeof startDt !== "string" || typeof endDt !== "string") {
          res.writeHead(400).end();
          return;
        }
        if (record.allDay) {
          // Conversion must clear the stale `date` field explicitly.
          if (startObj?.date !== null || endObj?.date !== null) {
            res.writeHead(400).end();
            return;
          }
        } else if (
          "date" in (startObj as Record<string, unknown>) ||
          "date" in (endObj as Record<string, unknown>)
        ) {
          res.writeHead(400).end();
          return;
        }
        record.start = startDt;
        record.end = endDt;
        record.allDay = false;
        record.patchCount += 1;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server?.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("fixture did not listen");
  }
  return `http://127.0.0.1:${(address as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server = undefined;
  });
});

beforeEach(async () => {
  baseUrl = await startFixture();
});

const GRANT = {
  executionId: "11111111-1111-4111-8111-111111111111",
  proposalId: "22222222-2222-4222-8222-222222222222",
  proposalHash: "a".repeat(64),
  tool: "calendar.reschedule" as const,
  inputHash: "b".repeat(64),
  expectedRevision: ETAG_V1,
};
const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Test-local Google-shaped wire provider: single GET read with strict
 * shape normalization + exactly ONE conditional PATCH (If-Match exact,
 * 412 mapping, no retry, no redirect follow). Mirrors the production
 * fork adapter semantics without importing the ignored nested repo:
 * valid all-day sources CONVERT to timed (PATCH clears `date: null` +
 * new `dateTime`); malformed all-day bounds are `invalid_input` with NO
 * patch. Timed sources keep `dateTime`-only bodies.
 */
function testWirePatch(input: {
  calendarId: string;
  eventId: string;
  account?: string;
  start: string;
  end: string;
  expectedEtag: string;
}): Promise<
  | { status: "succeeded" }
  | { status: "definite_failure"; code: string }
  | { status: "unknown"; code: string }
> {
  return (async () => {
    const url = `${baseUrl}/events/${encodeURIComponent(input.calendarId)}/${encodeURIComponent(input.eventId)}`;
    let current: FixtureEventRecord & {
      startDate?: string;
      endDate?: string;
    };
    const isStrictCalendarDate = (value: string): boolean => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const year = Number(value.slice(0, 4));
      const month = Number(value.slice(5, 7));
      const day = Number(value.slice(8, 10));
      if (month < 1 || month > 12) return false;
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth =
        [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
          month - 1
        ] ?? 0;
      return day >= 1 && day <= daysInMonth;
    };
    const isTimedEndpoint = (v: unknown): v is { dateTime: string } =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { dateTime?: unknown }).dateTime === "string" &&
      (v as { date?: unknown }).date === undefined;
    const isDateEndpoint = (v: unknown): v is { date: string } =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { date?: unknown }).date === "string" &&
      (v as { dateTime?: unknown }).dateTime === undefined &&
      isStrictCalendarDate((v as { date: string }).date);
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual" });
      if (res.status === 404) {
        return { status: "definite_failure", code: "not_found" } as const;
      }
      if (!res.ok)
        return { status: "unknown", code: "read_transport_lost" } as const;
      const body = (await res.json()) as {
        etag?: unknown;
        status?: unknown;
        start?: unknown;
        end?: unknown;
        recurrence?: unknown;
      };
      const isTimed = isTimedEndpoint;
      if (isTimed(body.start) && isTimed(body.end)) {
        current = {
          etag: typeof body.etag === "string" ? body.etag : "",
          status:
            body.status === "confirmed" || body.status === "tentative"
              ? body.status
              : body.status === "cancelled"
                ? "cancelled"
                : "deleted",
          start: body.start.dateTime,
          end: body.end.dateTime,
          recurring: body.recurrence !== undefined,
          allDay: false,
        };
      } else if (isDateEndpoint(body.start) && isDateEndpoint(body.end)) {
        const startMs = Date.parse(`${body.start.date}T00:00:00Z`);
        const endMs = Date.parse(`${body.end.date}T00:00:00Z`);
        if (
          Number.isNaN(startMs) ||
          Number.isNaN(endMs) ||
          !(endMs > startMs)
        ) {
          return { status: "definite_failure", code: "invalid_input" } as const;
        }
        current = {
          etag: typeof body.etag === "string" ? body.etag : "",
          status:
            body.status === "confirmed" || body.status === "tentative"
              ? body.status
              : body.status === "cancelled"
                ? "cancelled"
                : "deleted",
          start: "",
          end: "",
          recurring: body.recurrence !== undefined,
          allDay: true,
          startDate: body.start.date,
          endDate: body.end.date,
        };
      } else {
        return { status: "definite_failure", code: "invalid_input" } as const;
      }
    } catch {
      return { status: "unknown", code: "read_transport_lost" } as const;
    }
    if (current.status === "deleted" && current.etag === "") {
      return { status: "definite_failure", code: "not_found" } as const;
    }
    if (current.etag.length === 0) {
      return { status: "definite_failure", code: "auth_refused" } as const;
    }
    if (current.recurring) {
      return {
        status: "definite_failure",
        code: "recurring_unsupported",
      } as const;
    }
    if (current.status === "cancelled") {
      return {
        status: "definite_failure",
        code: "cancelled_unsupported",
      } as const;
    }
    if (current.status === "deleted") {
      return {
        status: "definite_failure",
        code: "deleted_unsupported",
      } as const;
    }
    if (current.allDay) {
      // Valid all-day converts (strict bounds already proven above); a
      // malformed source never reaches here (invalid_input with NO patch).
      if (current.start !== "" || current.end !== "") {
        return {
          status: "definite_failure",
          code: "invalid_input",
        } as const;
      }
    }
    const patchJson = current.allDay
      ? {
          start: { date: null, dateTime: input.start },
          end: { date: null, dateTime: input.end },
        }
      : {
          start: { dateTime: input.start },
          end: { dateTime: input.end },
        };
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "If-Match": input.expectedEtag,
        },
        body: JSON.stringify(patchJson),
        redirect: "manual",
      });
    } catch {
      return { status: "unknown", code: "transport_lost" } as const;
    }
    if (res.status === 412) {
      return { status: "definite_failure", code: "etag_mismatch" } as const;
    }
    if (res.status === 404) {
      return { status: "definite_failure", code: "not_found" } as const;
    }
    if (res.status >= 300 && res.status < 400) {
      // POST-dispatch 3xx mirror of the production fork adapter: the PATCH
      // was already received by the server (no redirect follow), so the
      // outcome is UNKNOWN (never definite, no resend).
      return { status: "unknown", code: "upstream_unknown" } as const;
    }
    if (!res.ok) {
      if (res.status >= 500)
        return { status: "unknown", code: "upstream_5xx" } as const;
      return { status: "definite_failure", code: "invalid_input" } as const;
    }
    return { status: "succeeded" } as const;
  })();
}

/**
 * Build the production-shaped caller: the test-local wire provider behind
 * the MCP classified-payload envelope (exactly what the dedicated
 * `reschedule-event` server returns on an intact transport).
 */
function realCaller(): RescheduleWriteCaller {
  return {
    async callTool(_name, args) {
      const input = args as {
        start: string;
        end: string;
        calendarId: string;
        eventId: string;
        account?: string;
        expectedEtag: string;
      };
      const outcome = await testWirePatch(input);
      if (outcome.status === "succeeded") {
        return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
      }
      if (outcome.status === "definite_failure") {
        return {
          ok: true,
          text: JSON.stringify({
            status: "definite_failure",
            code: outcome.code,
          }),
        };
      }
      return { ok: false, code: "mcp_unavailable" };
    },
  };
}

function portWith(caller: RescheduleWriteCaller, etag: string | null) {
  return createRescheduleWritePort({
    connectorInstanceId: CONNECTOR_ID,
    caller,
    resolveExpectedEtag: () => etag,
  });
}

function requestWithRevision(expectedRevision: string) {
  return {
    ...baseRequest(),
    grant: { ...GRANT, expectedRevision },
  };
}

function baseRequest() {
  return {
    grant: GRANT,
    connectorInstanceId: CONNECTOR_ID,
    tool: "calendar.reschedule" as const,
    start: START_NEW,
    end: END_NEW,
    targetResourceId: "resource-1",
    targetCanonicalKey: "canon-1",
    target: { calendarId: CALENDAR_ID, eventId: EVENT_ID },
  };
}

describe("dedicated reschedule write path (real HTTP fixture)", () => {
  it("success patches start/end ONLY with the exact If-Match etag", async () => {
    const port = portWith(realCaller(), ETAG_V1);
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "succeeded" });
    const record = store.get(key(CALENDAR_ID, EVENT_ID));
    expect(record?.start).toBe(START_NEW);
    expect(record?.end).toBe(END_NEW);
    expect(record?.patchCount).toBe(1);
    expect(lastPatch?.headers["if-match"]).toBe(ETAG_V1);
    const parsed = JSON.parse(lastPatch?.body ?? "{}") as {
      start?: unknown;
      end?: unknown;
    };
    expect(Object.keys(parsed).sort()).toEqual(["end", "start"]);
    expect(parsed.start).toEqual({ dateTime: START_NEW });
    expect(parsed.end).toEqual({ dateTime: END_NEW });
  });

  it("etag mismatch (412) is definite_failure and applies NO patch", async () => {
    // Committed stale revision: resolver answers the EXACT approved
    // (stale) etag, so the single PATCH is dispatched with If-Match stale
    // and the provider proves NO patch via 412.
    const port = portWith(realCaller(), '"stale-etag"');
    const outcome = await port.update(requestWithRevision('"stale-etag"'));
    expect(outcome).toEqual({ status: "definite_failure" });
    const record = store.get(key(CALENDAR_ID, EVENT_ID));
    expect(record?.start).toBe("2026-02-01T10:00:00Z");
    expect(record?.patchCount).toBe(0);
  });

  it("recurring events are rejected with NO patch dispatched", async () => {
    const record = store.get(key(CALENDAR_ID, EVENT_ID));
    if (record !== undefined) record.recurring = true;
    const port = portWith(realCaller(), ETAG_V1);
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
    expect(record?.patchCount).toBe(0);
  });

  it("cancelled / deleted events are rejected with NO patch", async () => {
    for (const shape of [
      { status: "cancelled", allDay: false },
      { status: "deleted", allDay: false },
    ] as const) {
      store = freshStore();
      lastPatch = null;
      const record = store.get(key(CALENDAR_ID, EVENT_ID));
      if (record !== undefined) {
        record.status = shape.status;
        record.allDay = shape.allDay;
      }
      const port = portWith(realCaller(), ETAG_V1);
      const outcome = await port.update(baseRequest());
      expect(outcome).toEqual({ status: "definite_failure" });
      expect(lastPatch).toBeNull();
    }
  });

  it("valid all-day converts: ONE date-clearing PATCH with exact If-Match", async () => {
    store = freshStore();
    lastPatch = null;
    const record = store.get(key(CALENDAR_ID, EVENT_ID));
    if (record !== undefined) record.allDay = true;
    const port = portWith(realCaller(), ETAG_V1);
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "succeeded" });
    expect(record?.patchCount).toBe(1);
    const sentPatch = lastPatch as unknown as {
      headers: Record<string, string | undefined>;
      body: string;
    } | null;
    expect(sentPatch?.headers["if-match"]).toBe(ETAG_V1);
    const parsed = JSON.parse(sentPatch?.body ?? "{}") as {
      start?: unknown;
      end?: unknown;
    };
    expect(Object.keys(parsed).sort()).toEqual(["end", "start"]);
    expect(parsed.start).toEqual({ date: null, dateTime: START_NEW });
    expect(parsed.end).toEqual({ date: null, dateTime: END_NEW });
    expect(record?.allDay).toBe(false);
    expect(record?.start).toBe(START_NEW);
    expect(record?.end).toBe(END_NEW);
  });

  it("malformed all-day bounds are invalid_input with NO patch", async () => {
    const shapes: Array<{ start: unknown; end: unknown }> = [
      // Rollover date (Feb 30) is not a strict calendar date.
      { start: { date: "2026-02-30" }, end: { date: "2026-03-01" } },
      // Mixed timed/date endpoints.
      {
        start: { date: "2026-02-01" },
        end: { dateTime: "2026-02-02T10:00:00Z" },
      },
      // Reversed exclusive end (end <= start).
      { start: { date: "2026-02-02" }, end: { date: "2026-02-01" } },
    ];
    for (const shape of shapes) {
      store = freshStore();
      lastPatch = null;
      const record = store.get(key(CALENDAR_ID, EVENT_ID));
      if (record !== undefined) {
        record.allDay = true;
        record.wireStartOverride = shape.start;
        record.wireEndOverride = shape.end;
      }
      const port = portWith(realCaller(), ETAG_V1);
      const outcome = await port.update(baseRequest());
      expect(outcome).toEqual({ status: "definite_failure" });
      expect(lastPatch).toBeNull();
      expect(record?.patchCount).toBe(0);
    }
  });

  it("hash/updated-only revision (no etag) is rejected with NO dispatch", async () => {
    const port = portWith(realCaller(), null);
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
  });

  it("content-hash fallback revision is rejected even when resolved (no source-etag basis)", async () => {
    const hashRevision = "c".repeat(64);
    const port = portWith(realCaller(), hashRevision);
    const outcome = await port.update(requestWithRevision(hashRevision));
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
    expect(isSourceEtagBasis(hashRevision)).toBe(false);
  });

  it("updated-timestamp revision is rejected even when resolved (no source-etag basis)", async () => {
    const updatedRevision = "2026-02-01T10:00:00.000Z";
    const port = portWith(realCaller(), updatedRevision);
    const outcome = await port.update(requestWithRevision(updatedRevision));
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
    expect(isSourceEtagBasis(updatedRevision)).toBe(false);
  });

  it("resolver substitution (answer !== approved revision) is rejected with NO dispatch", async () => {
    const port = createRescheduleWritePort({
      connectorInstanceId: CONNECTOR_ID,
      caller: realCaller(),
      // Fresh-read-style substitution: answers a live etag that is NOT the
      // committed approved revision. Must never be used as If-Match.
      resolveExpectedEtag: () => '"live-fresh-etag"',
    });
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
  });

  it("resolver is keyed by the exact committed grant (execution/proposal/hash/revision)", async () => {
    let seen: unknown;
    const port = createRescheduleWritePort({
      connectorInstanceId: CONNECTOR_ID,
      caller: realCaller(),
      resolveExpectedEtag: (grant) => {
        seen = { ...grant };
        return grant.expectedRevision;
      },
    });
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen).toEqual({
      executionId: GRANT.executionId,
      proposalId: GRANT.proposalId,
      proposalHash: GRANT.proposalHash,
      expectedRevision: ETAG_V1,
    });
  });

  it("after-dispatch abort is unknown with exactly ONE attempt (no resend)", async () => {
    let attempts = 0;
    const caller: RescheduleWriteCaller = {
      async callTool() {
        attempts += 1;
        const controller = new AbortController();
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const port = portWith(caller, ETAG_V1);
    const outcome = await port.update(baseRequest());
    expect(outcome).toEqual({ status: "unknown" });
    expect(attempts).toBe(1);
  });

  it("lost/unparseable response is unknown, never definite_failure", async () => {
    const caller: RescheduleWriteCaller = {
      async callTool() {
        return { ok: true, text: "not-json{{{" };
      },
    };
    const port = portWith(caller, ETAG_V1);
    expect(await port.update(baseRequest())).toEqual({ status: "unknown" });

    const denied: RescheduleWriteCaller = {
      async callTool() {
        return { ok: false, code: "mcp_unavailable" };
      },
    };
    expect(await portWith(denied, ETAG_V1).update(baseRequest())).toEqual({
      status: "unknown",
    });
  });

  it("wrong tool/instance binding is refused without dispatch", async () => {
    const port = portWith(realCaller(), ETAG_V1);
    const wrongTool = await port.update({
      ...baseRequest(),
      tool: "calendar.search" as unknown as "calendar.reschedule",
    });
    expect(wrongTool).toEqual({ status: "definite_failure" });
    const wrongInstance = await port.update({
      ...baseRequest(),
      connectorInstanceId: "44444444-4444-4444-8444-444444444444",
    });
    expect(wrongInstance).toEqual({ status: "definite_failure" });
    expect(lastPatch).toBeNull();
  });

  it("throwing committed-grant resolver is definite_failure with NO dispatch", async () => {
    // The grant store is unreadable BEFORE any MCP call: the no-commit proof
    // is intact, so the port classifies definite (never unknown-commit).
    let calls = 0;
    const caller: RescheduleWriteCaller = {
      async callTool() {
        calls += 1;
        return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
      },
    };
    const port = createRescheduleWritePort({
      connectorInstanceId: CONNECTOR_ID,
      caller,
      resolveExpectedEtag: () => {
        throw new Error("grant store unreadable");
      },
    });
    expect(await port.update(baseRequest())).toEqual({
      status: "definite_failure",
    });
    expect(calls).toBe(0);
    expect(lastPatch).toBeNull();
  });

  it("sub-millisecond instants are rejected before any dispatch; ms-expressible fractions accepted", async () => {
    const { isStrictCalendarInstant, RescheduleWriteMcpInputSchema } =
      await import("../src/rescheduleWrite.js");
    // Genuine sub-ms precision (nonzero past the ms position) is rejected.
    expect(isStrictCalendarInstant("2026-03-01T10:00:00.1234Z")).toBe(false);
    expect(isStrictCalendarInstant("2026-03-01T10:00:00.1230001Z")).toBe(false);
    // Millisecond-expressible fractions name the same ms: accepted.
    expect(isStrictCalendarInstant("2026-03-01T10:00:00.123Z")).toBe(true);
    expect(isStrictCalendarInstant("2026-03-01T10:00:00.123000Z")).toBe(true);
    expect(isStrictCalendarInstant("2026-03-01T10:00:00.12Z")).toBe(true);
    expect(
      RescheduleWriteMcpInputSchema.safeParse({
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        start: "2026-03-01T10:00:00.1234Z",
        end: "2026-03-01T11:00:00Z",
        expectedEtag: ETAG_V1,
      }).success,
    ).toBe(false);
    // The port refuses sub-ms input BEFORE dispatch: no MCP call, no PATCH.
    let calls = 0;
    const caller: RescheduleWriteCaller = {
      async callTool() {
        calls += 1;
        return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
      },
    };
    const outcome = await portWith(caller, ETAG_V1).update({
      ...baseRequest(),
      start: "2026-03-01T10:00:00.1234Z",
      end: "2026-03-01T11:00:00Z",
    });
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(calls).toBe(0);
    expect(lastPatch).toBeNull();
  });

  it("structuredContent is authoritative when present; strict text only when absent", async () => {
    // Present-but-malformed structuredContent is NEVER rescued by valid
    // text (a fallback could forge a verified receipt the provider did not
    // classify).
    const malformed: RescheduleWriteCaller = {
      async callTool() {
        return {
          ok: true,
          text: JSON.stringify({ status: "succeeded" }),
          structuredContent: { status: "bogus" },
        };
      },
    };
    expect(await portWith(malformed, ETAG_V1).update(baseRequest())).toEqual({
      status: "unknown",
    });
    // Present-valid structuredContent wins over conflicting text.
    const authoritative: RescheduleWriteCaller = {
      async callTool() {
        return {
          ok: true,
          text: JSON.stringify({ status: "unknown" }),
          structuredContent: { status: "succeeded" },
        };
      },
    };
    expect(
      await portWith(authoritative, ETAG_V1).update(baseRequest()),
    ).toEqual({ status: "succeeded" });
    // Absent structuredContent preserves the strict-text fallback.
    const textOnly: RescheduleWriteCaller = {
      async callTool() {
        return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
      },
    };
    expect(await portWith(textOnly, ETAG_V1).update(baseRequest())).toEqual({
      status: "succeeded",
    });
  });

  it("strict host date mirror: Feb 30 rejected, leap Feb 29 accepted", async () => {
    const { isStrictCalendarInstant, RescheduleWriteMcpInputSchema } =
      await import("../src/rescheduleWrite.js");
    expect(isStrictCalendarInstant("2023-02-30T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-02-29T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-04-31T10:00:00+02:00")).toBe(false);
    expect(isStrictCalendarInstant("2024-02-29T10:00:00Z")).toBe(true);
    expect(isStrictCalendarInstant("2024-02-29T10:00:00.5+05:30")).toBe(true);
    expect(
      RescheduleWriteMcpInputSchema.safeParse({
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        start: "2023-02-30T10:00:00Z",
        end: "2023-02-30T11:00:00Z",
        expectedEtag: ETAG_V1,
      }).success,
    ).toBe(false);
    expect(
      RescheduleWriteMcpInputSchema.safeParse({
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        start: "2024-02-29T10:00:00Z",
        end: "2024-02-29T11:00:00Z",
        expectedEtag: ETAG_V1,
      }).success,
    ).toBe(true);
  });
});
