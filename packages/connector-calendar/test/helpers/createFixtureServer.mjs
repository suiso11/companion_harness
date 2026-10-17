#!/usr/bin/env node
// M6 TEST FIXTURE MCP server — tracked, clean-clone-safe, NEVER production.
//
// A minimal stdio MCP double used ONLY by create suites that want a spawned
// entrypoint, mirroring `rescheduleFixtureServer.mjs`. It exposes the same
// narrow contract as the real separate create entrypoint (tool
// `create-event`, exact body `{ id, summary, start, end }` + opaque
// selection, `already-exists` 409 -> definite `already_exists`, never an
// overwrite, never a retry) against the loopback Google-shaped fixture whose
// base URL arrives via `--endpoint-base <url>` argv (or the legacy
// `M6_CREATE_TEST_ENDPOINT_BASE` child env; required — the process exits
// non-zero without it).
//
// Identity is deliberately the fixture's own
// (`google-calendar-create-test-fixture` / `0.0.0-fixture.1`) so it can
// never be mistaken for production (`google-calendar-create` /
// `1.0.0-create.1`). To drive a test against the REAL fork bundle instead,
// set `M6_CREATE_FORK_CLI` to a built `build/create-cli.js` (explicit setup;
// missing path is a hard error, never a silent skip). No live Google, no
// OAuth, fixture data only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FIXTURE_MCP_NAME = "google-calendar-create-test-fixture";
const FIXTURE_MCP_VERSION = "0.0.0-fixture.1";
const CREATE_TOOL_NAME = "create-event";

/** Loopback endpoint: `--endpoint-base <url>` argv first, legacy env fallback. */
function endpointBase(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--endpoint-base" && index + 1 < argv.length) {
      const value = argv[index + 1];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return process.env.M6_CREATE_TEST_ENDPOINT_BASE ?? "";
}

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

function isStrictCalendarInstant(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    return false;
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

const CreateEventInputSchema = z
  .strictObject({
    calendarId: z.string().min(1).max(512),
    account: z.string().min(1).max(512).optional(),
    id: z
      .string()
      .length(32)
      .regex(/^[0-9a-f]+$/, "stable event id must be 32 lowercase hex chars"),
    summary: z.string().min(1).max(256),
    start: IsoInstantSchema,
    end: IsoInstantSchema,
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

function insertUrl(base, calendarId) {
  return `${base.replace(/\/$/, "")}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

async function main() {
  const argv = process.argv.slice(2);
  const base = endpointBase(argv);
  if (base.length === 0) {
    console.error("fixture server: M6_CREATE_TEST_ENDPOINT_BASE not set");
    process.exit(2);
  }
  const server = new McpServer(
    { name: FIXTURE_MCP_NAME, version: FIXTURE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );
  // The advertised JSON schema and the runtime validator are THE SAME strict
  // schema object: `strictObject` advertises `additionalProperties: false`
  // on the wire AND rejects unknown keys at runtime (mirrors the real fork
  // entrypoint exactly). Body discipline: `{ id, summary, start, end }`
  // ONLY — description/attendees/recurrence never exist here.
  server.registerTool(
    CREATE_TOOL_NAME,
    {
      title: "Create event fixture (id/summary/start/end only)",
      description:
        "Test fixture mirroring the create-event contract against a loopback fixture. Never production.",
      inputSchema: CreateEventInputSchema,
    },
    async (args, extra) => {
      const parsed = CreateEventInputSchema.safeParse(args);
      if (!parsed.success) return definite("invalid_input");
      const input = parsed.data;
      const url = insertUrl(base, input.calendarId);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.account !== undefined
              ? { "x-fixture-account": input.account }
              : {}),
          },
          body: JSON.stringify({
            id: input.id,
            summary: input.summary,
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
      if (res.status === 409) return definite("already_exists");
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
