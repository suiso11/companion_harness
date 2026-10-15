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

type StoredEvent = FixtureEventRecord & { patchCount: number };

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
  return {
    id: EVENT_ID,
    etag: record.etag,
    status: record.status,
    start: record.allDay ? { date: "2026-02-01" } : { dateTime: record.start },
    end: record.allDay ? { date: "2026-02-02" } : { dateTime: record.end },
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
        const startDt =
          typeof patch.start === "object" && patch.start !== null
            ? (patch.start as { dateTime?: unknown }).dateTime
            : undefined;
        const endDt =
          typeof patch.end === "object" && patch.end !== null
            ? (patch.end as { dateTime?: unknown }).dateTime
            : undefined;
        if (typeof startDt !== "string" || typeof endDt !== "string") {
          res.writeHead(400).end();
          return;
        }
        record.start = startDt;
        record.end = endDt;
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
 * fork adapter semantics without importing the ignored nested repo.
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
    let current: FixtureEventRecord;
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
      const isTimed = (v: unknown): v is { dateTime: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as { dateTime?: unknown }).dateTime === "string" &&
        (v as { date?: unknown }).date === undefined;
      const allDay = !isTimed(body.start) || !isTimed(body.end);
      current = {
        etag: typeof body.etag === "string" ? body.etag : "",
        status:
          body.status === "confirmed" || body.status === "tentative"
            ? body.status
            : body.status === "cancelled"
              ? "cancelled"
              : "deleted",
        start: isTimed(body.start) ? body.start.dateTime : "",
        end: isTimed(body.end) ? body.end.dateTime : "",
        recurring: body.recurrence !== undefined,
        allDay,
      };
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
      return {
        status: "definite_failure",
        code: "allday_unsupported",
      } as const;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "If-Match": input.expectedEtag,
        },
        body: JSON.stringify({
          start: { dateTime: input.start },
          end: { dateTime: input.end },
        }),
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
      return { status: "definite_failure", code: "invalid_input" } as const;
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

  it("cancelled / deleted / all-day events are rejected with NO patch", async () => {
    for (const shape of [
      { status: "cancelled", allDay: false },
      { status: "deleted", allDay: false },
      { status: "confirmed", allDay: true },
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
});
