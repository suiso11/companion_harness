#!/usr/bin/env node
// M5 TEST FIXTURE MCP server — tracked, clean-clone-safe, NEVER production.
//
// This is a minimal stdio MCP double used ONLY by
// `packages/connector-calendar/test/rescheduleProcess.test.ts` so the root
// suite passes on a clean clone with no nested fork checkout. It exposes the
// same narrow contract as the real separate entrypoint (tool
// `reschedule-event`, start/end-only + opaque selection + `expectedEtag`,
// exactly ONE conditional PATCH with `If-Match`, 412 -> definite
// `etag_mismatch`) against the loopback Google-shaped fixture whose base URL
// arrives via `M5_RESCHEDULE_TEST_ENDPOINT_BASE` (required; the process
// exits non-zero without it). No credential namespace, no OAuth, no live
// Google, fixture data only.
//
// The REAL production entrypoint lives in the fork (derived branch
// `feat/m5-reschedule-entrypoint-v2`, draft PR suiso11/google-calendar-mcp#3,
// base commit 6939311): identity `google-calendar-reschedule` /
// `1.0.0-reschedule.1`. THIS fixture intentionally reports its own identity
// (`google-calendar-reschedule-test-fixture` / `0.0.0-fixture.1`) so it can
// never be mistaken for production. To drive the test against the REAL fork
// bundle instead, set `M5_RESCHEDULE_FORK_CLI` to a built
// `build/reschedule-cli.js` (explicit setup; missing path is a hard error,
// never a silent skip).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FIXTURE_MCP_NAME = "google-calendar-reschedule-test-fixture";
const FIXTURE_MCP_VERSION = "0.0.0-fixture.1";
const RESCHEDULE_TOOL_NAME = "reschedule-event";

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

// Strict calendar-date mirror of the fork `isStrictCalendarInstant`
// contract (no `Date.parse` rollover: `2023-02-30` is rejected). Refines are
// invisible to the advertised JSON schema, so the pinned live-wire hash is
// unchanged.
function isStrictCalendarInstant(value) {
  if (value.length === 0 || value.length > 128) return false;
  const m = ISO_INSTANT_PATTERN.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const zone = m[8] ?? "";
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offHour = Number(m[9]);
    const offMinute = Number(m[10]);
    if (offHour > 23 || offMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => isStrictCalendarInstant(value),
    "start/end must be RFC3339 instants with an explicit offset",
  );

const RescheduleEventInputSchema = z
  .strictObject({
    calendarId: z.string().min(1).max(512),
    eventId: z.string().min(1).max(1024),
    account: z.string().min(1).max(512).optional(),
    start: IsoInstantSchema,
    end: IsoInstantSchema,
    expectedEtag: z.string().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    const startMs = Date.parse(value.start);
    const endMs = Date.parse(value.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || !(endMs > startMs)) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });

function definite(code) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "definite_failure", code }),
      },
    ],
  };
}

function eventUrl(base, calendarId, eventId) {
  return `${base.replace(/\/$/, "")}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

async function main() {
  const base = process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE ?? "";
  if (base.length === 0) {
    console.error("fixture server: M5_RESCHEDULE_TEST_ENDPOINT_BASE not set");
    process.exit(2);
  }
  const server = new McpServer(
    { name: FIXTURE_MCP_NAME, version: FIXTURE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );
  // The advertised JSON schema and the runtime validator are THE SAME
  // strict schema object: `strictObject` advertises
  // `additionalProperties: false` on the wire AND rejects unknown keys at
  // runtime (mirrors the real fork entrypoint exactly).
  server.registerTool(
    RESCHEDULE_TOOL_NAME,
    {
      title: "Reschedule event fixture (start/end only, conditional etag)",
      description:
        "Test fixture mirroring the reschedule-event contract against a loopback fixture. Never production.",
      inputSchema: RescheduleEventInputSchema,
    },
    async (args, extra) => {
      const parsed = RescheduleEventInputSchema.safeParse(args);
      if (!parsed.success) return definite("invalid_input");
      const input = parsed.data;
      const url = eventUrl(base, input.calendarId, input.eventId);
      let current;
      try {
        current = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: extra?.signal,
          redirect: "manual",
        });
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "transport_lost" }],
        };
      }
      if (current.status === 404 || current.status === 410) {
        return definite("not_found");
      }
      if (!current.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: "transport_lost" }],
        };
      }
      let res;
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
          signal: extra?.signal,
          redirect: "manual",
        });
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "transport_lost" }],
        };
      }
      if (res.status === 412) return definite("etag_mismatch");
      if (res.status === 404 || res.status === 410)
        return definite("not_found");
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: "transport_lost" }],
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ status: "succeeded" }) },
        ],
      };
    },
  );
  const transport = new StdioServerTransport();
  const close = async () => {
    try {
      await transport.close();
    } catch {
      // Best effort.
    }
    try {
      await server.close();
    } catch {
      // Best effort.
    }
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  await server.connect(transport);
}

await main();
