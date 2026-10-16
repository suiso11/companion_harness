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
// arrives via `--endpoint-base <url>` argv (or the legacy
// `M5_RESCHEDULE_TEST_ENDPOINT_BASE` child env; required — the process exits
// non-zero without it). File-auth mode (active ONLY with the `--file-auth`
// argv flag) additionally mirrors the REAL production CLI
// credential contract against TEMP files only — account grammar, resolved
// write/readonly path collision before any file read, no partial-env
// fallthrough, client registration + per-account exact-scope grant, and the
// explicit-target account gate — refusing BEFORE listening with no patch.
// No OAuth, no live Google, fixture data only. All-day conversion mirror: a valid all-day
// loopback source (strict YYYY-MM-DD bounds, exclusive end > start)
// converts to timed with `date: null` clearing + new `dateTime` (exactly
// like the real provider); malformed bounds are `invalid_input` with NO
// patch. Timed sources keep dateTime-only bodies.
//
// The REAL production entrypoint lives in the fork (branch
// `feat/m5-allday-conversion`, fork PR suiso11/google-calendar-mcp#4,
// base commit 6939311): identity `google-calendar-reschedule` /
// `1.0.0-reschedule.1`. THIS fixture intentionally reports its own identity
// (`google-calendar-reschedule-test-fixture` / `0.0.0-fixture.1`) so it can
// never be mistaken for production. To drive the test against the REAL fork
// bundle instead, set `M5_RESCHEDULE_FORK_CLI` to a built
// `build/reschedule-cli.js` (explicit setup; missing path is a hard error,
// never a silent skip).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FIXTURE_MCP_NAME = "google-calendar-reschedule-test-fixture";
const FIXTURE_MCP_VERSION = "0.0.0-fixture.1";
const RESCHEDULE_TOOL_NAME = "reschedule-event";

// File-auth contract mirror (used ONLY when the child is spawned with the
// `--file-auth` argv flag — the file-only operator tests through the normal
// host factory. The flag (not env sniffing) selects the mode, so an ambient
// `M5_RESCHEDULE_*` value on the developer machine can never flip the legacy
// injected-seam suites into credential checks). It mirrors the REAL fork
// production CLI (`src/reschedule/cli.ts` `resolveWriteRuntimeCredential` +
// `src/reschedule/provider.ts` `validateWriteCredential` + the provider
// exact-account gate) WITHOUT any Google contact: the same refusal ORDER
// (account grammar -> write/readonly path collision BEFORE any file read ->
// partial-env no-fallthrough -> client registration -> per-account exact-scope
// grant) and the same per-request explicit-target account gate. Refusals exit
// non-zero BEFORE listening (`auth_refused`, like the real CLI exit 2), so a
// host that drops a wiring variable fails here instead of succeeding. When
// `M5_RESCHEDULE_ACCOUNT` is unset the fixture keeps its legacy behavior
// (endpoint only, no credential checks) for the older injected-seam suites.
const FILE_AUTH_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const FILE_AUTH_BROAD_SCOPE = "https://www.googleapis.com/auth/calendar";
const FILE_AUTH_ACCOUNT_PATTERN = /^[a-z0-9_-]{1,64}$/;
// Fork `validateAccountId` reserved names (same refusal, never an account).
const FILE_AUTH_RESERVED_ACCOUNTS = new Set([
  ".",
  "..",
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "lpt1",
  "lpt2",
  "lpt3",
]);
const FILE_AUTH_EXPLICIT_CRED_NAMES = [
  "M5_RESCHEDULE_CLIENT_ID",
  "M5_RESCHEDULE_CLIENT_SECRET",
  "M5_RESCHEDULE_REFRESH_TOKEN",
  "M5_RESCHEDULE_GRANTED_SCOPE",
  "M5_RESCHEDULE_ACCESS_TOKEN",
];

function fileAuthRefuse(reason) {
  console.error(`fixture server: file-auth refused (${reason})`);
  process.exit(2);
}

/** Loopback endpoint: `--endpoint-base <url>` argv first, legacy env fallback. */
function fileAuthEndpointBase(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--endpoint-base" && index + 1 < argv.length) {
      const value = argv[index + 1];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE ?? "";
}

/**
 * Enforce the file-only credential contract at startup (no I/O beyond the
 * two temp files, no network, no Google). Returns the configured account for
 * the per-request target gate, or null when file-auth mode is off.
 */
function enforceFileAuth(env, argv) {
  if (!argv.includes("--file-auth")) return null;
  const account = env.M5_RESCHEDULE_ACCOUNT ?? "";
  if (account.length === 0) fileAuthRefuse("auth_refused");
  if (
    !FILE_AUTH_ACCOUNT_PATTERN.test(account) ||
    FILE_AUTH_RESERVED_ACCOUNTS.has(account)
  ) {
    fileAuthRefuse("auth_refused");
  }
  // Collision BEFORE any file read (resolved paths — the provider owns
  // resolution, so relative aliases of the same file still collide here).
  const writeOverride = env.M5_RESCHEDULE_WRITE_TOKEN_PATH ?? "";
  const writePath =
    writeOverride.length > 0
      ? resolve(writeOverride)
      : join(homedir(), ".config", "google-calendar-mcp-write", "tokens.json");
  const readonlyOverride = env.GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH ?? "";
  const readonlyPath =
    readonlyOverride.length > 0
      ? resolve(readonlyOverride)
      : join(
          homedir(),
          ".config",
          "google-calendar-mcp-readonly",
          "tokens.json",
        );
  if (writePath === readonlyPath) {
    fileAuthRefuse("auth_refused");
  }
  // Any partial explicit env credential refuses WITHOUT file fallthrough.
  for (const name of FILE_AUTH_EXPLICIT_CRED_NAMES) {
    const value = env[name] ?? "";
    if (value.length > 0) {
      fileAuthRefuse("auth_refused");
    }
  }
  // Existing OAuth client registration (Desktop file, path only in env).
  const clientFile = env.GOOGLE_OAUTH_CREDENTIALS ?? "";
  if (clientFile.length === 0) {
    fileAuthRefuse("auth_refused");
  }
  let registration;
  try {
    registration = JSON.parse(readFileSync(clientFile, "utf-8"));
  } catch {
    fileAuthRefuse("auth_refused");
  }
  if (
    typeof registration?.client_id !== "string" ||
    registration.client_id.length === 0 ||
    typeof registration?.client_secret !== "string" ||
    registration.client_secret.length === 0
  ) {
    fileAuthRefuse("auth_refused");
  }
  // Per-account persisted grant with the exact least-privilege scope.
  const tokenFile = env.M5_RESCHEDULE_WRITE_TOKEN_PATH ?? "";
  if (tokenFile.length === 0) {
    fileAuthRefuse("auth_refused");
  }
  let stored;
  try {
    stored = JSON.parse(readFileSync(tokenFile, "utf-8"));
  } catch {
    fileAuthRefuse("auth_refused");
  }
  const grant =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? stored[account]
      : undefined;
  const refresh =
    typeof grant?.refresh_token === "string" ? grant.refresh_token : "";
  const scope = typeof grant?.scope === "string" ? grant.scope : "";
  const tokens = scope.split(/[\t\n\f\r ]+/).filter((t) => t.length > 0);
  if (
    refresh.length === 0 ||
    !tokens.some((t) => t === FILE_AUTH_WRITE_SCOPE) ||
    tokens.some((t) => t === FILE_AUTH_BROAD_SCOPE)
  ) {
    fileAuthRefuse("auth_refused");
  }
  return account;
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

// Strict YYYY-MM-DD mirror of the fork `isStrictCalendarDate` contract
// (no rollover: `2026-02-30` is rejected). Wire schema unchanged.
function isStrictCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
    0;
  return day >= 1 && day <= daysInMonth;
}

function isTimedEndpoint(value) {
  if (typeof value !== "object" || value === null) return false;
  return typeof value.dateTime === "string" && value.date === undefined;
}

function isDateEndpoint(value) {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof value.date === "string" &&
    value.dateTime === undefined &&
    isStrictCalendarDate(value.date)
  );
}

// Classify the loopback GET observation exactly like the real provider:
// timed (both dateTime), valid all-day (both strict YYYY-MM-DD date with
// exclusive end > start), or malformed (mixed/bad/reversed → invalid_input
// with NO patch, mirroring `normalizeGoogleObservation`).
function classifySource(body) {
  if (typeof body !== "object" || body === null) return { kind: "malformed" };
  const { start, end } = body;
  if (isTimedEndpoint(start) && isTimedEndpoint(end)) {
    return { kind: "timed" };
  }
  if (isDateEndpoint(start) && isDateEndpoint(end)) {
    const startMs = Date.parse(`${start.date}T00:00:00Z`);
    const endMs = Date.parse(`${end.date}T00:00:00Z`);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
      return { kind: "allDay", startDate: start.date, endDate: end.date };
    }
  }
  return { kind: "malformed" };
}

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
  const argv = process.argv.slice(2);
  const base = fileAuthEndpointBase(argv);
  if (base.length === 0) {
    console.error("fixture server: M5_RESCHEDULE_TEST_ENDPOINT_BASE not set");
    process.exit(2);
  }
  // File-only operator contract (temp files only): refuses BEFORE listening
  // when the wiring is incomplete, exactly like the real production CLI.
  const fileAuthAccount = enforceFileAuth(process.env, argv);
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
      // Exact configured-account gate (mirrors the real provider BEFORE any
      // token or provider I/O): an explicit target account that does not
      // equal the configured file-auth account is refused with NO patch.
      if (
        fileAuthAccount !== null &&
        input.account !== undefined &&
        input.account !== fileAuthAccount
      ) {
        return definite("auth_refused");
      }
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
      // Mirror the real provider: classify the source BEFORE any PATCH.
      // Valid all-day converts (PATCH clears `date: null` + new `dateTime`,
      // exactly like UpdateEventHandler/RecurringEventHelpers timed writes);
      // malformed all-day (bad/mixed/reversed bounds) is `invalid_input`
      // with NO patch dispatched. Timed sources keep dateTime-only bodies.
      let source = { kind: "malformed" };
      try {
        source = classifySource(await current.json());
      } catch {
        return definite("invalid_input");
      }
      if (source.kind === "malformed") return definite("invalid_input");
      const patchBody =
        source.kind === "allDay"
          ? {
              start: { date: null, dateTime: input.start },
              end: { date: null, dateTime: input.end },
            }
          : {
              start: { dateTime: input.start },
              end: { dateTime: input.end },
            };
      let res;
      try {
        res = await fetch(url, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "If-Match": input.expectedEtag,
          },
          body: JSON.stringify(patchBody),
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
