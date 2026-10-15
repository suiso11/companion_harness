// Host-owned pinned dedicated reschedule write identity (M5, separate entrypoint).
//
// This module is TRUSTED HOST CODE: it owns the one reviewed dedicated WRITE
// candidate adoption (fork pin + exact live-wire schema hash + expected wire
// identity for `google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
// `reschedule-event` ONLY). It is SEPARATE from the readonly profile
// (`calendarReadonlyProfile.ts`): the readonly surface keeps zero write tools
// and this module never enters the read allowlist.
//
// Candidate provenance (verified by exact wire probe, never guessed):
// - repo: https://github.com/suiso11/google-calendar-mcp
// - derived branch: feat/m5-reschedule-entrypoint-v2 (draft PR #3)
// - base commit: 6939311fd3eae9846648e0a175e304c9500f578e (readonly cutover)
// - wire identity: serverInfo { name: "google-calendar-reschedule",
//   version: "1.0.0-reschedule.1" } (fork src/reschedule/schema.ts +
//   src/reschedule/server.ts; McpServer name/version, distinct from the
//   readonly `google-calendar` / `3.0.0-readonly.2`).
// - surface: EXACTLY `reschedule-event` (start/end only + opaque selection +
//   committed-grant `expectedEtag`; strict, additionalProperties false).
// - OAuth scope: ONLY https://www.googleapis.com/auth/calendar.events
//   (separate `M5_RESCHEDULE_*` credential namespace; readonly tokens and
//   the readonly `calendar.events.readonly` scope are never reused).
// - launch entry: <fork>/build/reschedule-cli.js (separate stdio process).
//
// Binding pin: the hash below is the LIVE-WIRE canonical input-schema
// SHA-256 (what the connector verifies over the real SDK wire via
// tools/list, `canonicalSchemaHash`). Probed 2026-10-15 over REAL stdio
// against BOTH the freshly built fork bundle
// (`.m5-write-fork-derived/build/reschedule-cli.js`) and the tracked
// contract-mirror fixture
// (`packages/connector-calendar/test/helpers/rescheduleFixtureServer.mjs`):
// both advertise byte-identical STRICT input schemas
// (`additionalProperties: false` + `$schema` key) with hash
// `9f59e35b…8609d7`. The fork's removed hand-written
// `rescheduleInputJsonSchema()` (neither strict nor `$schema`) MUST NOT be
// used here.

import type { McpBindingDefinition } from "@companion/connector-mcp";

/** Expected dedicated-write wire identity (exact, case-sensitive). */
export const RESCHEDULE_WRITE_SERVER_NAME =
  "google-calendar-reschedule" as const;
export const RESCHEDULE_WRITE_SERVER_VERSION = "1.0.0-reschedule.1" as const;

/** The ONLY tool on the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_TOOL_NAME = "reschedule-event" as const;

/**
 * Pinned LIVE-WIRE canonical input-schema hash for `reschedule-event`
 * (SDK wire bytes, including the `$schema` annotation key).
 */
export const RESCHEDULE_WRITE_WIRE_HASH =
  "9f59e35bf76bfec75a99546fc3c22348cd20e33e9414154ea321d414186d09b7" as const;

/** Pinned fork provenance for the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_FORK = Object.freeze({
  repo: "https://github.com/suiso11/google-calendar-mcp",
  branch: "feat/m5-reschedule-entrypoint-v2",
  baseCommit: "6939311fd3eae9846648e0a175e304c9500f578e",
  serverName: RESCHEDULE_WRITE_SERVER_NAME,
  version: RESCHEDULE_WRITE_SERVER_VERSION,
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  entry: "build/reschedule-cli.js",
});

/**
 * Host-owned trusted dedicated WRITE definition for the adopted candidate.
 * Fresh frozen copy on every call; caller mutation can never affect the
 * pinned module state or a later resolution. Category is exactly `write`
 * so only a dedicated `["write"]` connector gate can ever enable it — a
 * default readonly connector refuses it with `mcp_binding_not_allowed`.
 */
export function getRescheduleWriteDefinitions(): readonly McpBindingDefinition[] {
  const def: McpBindingDefinition = {
    upstreamTool: RESCHEDULE_WRITE_TOOL_NAME,
    canonicalSchemaHash: RESCHEDULE_WRITE_WIRE_HASH,
    category: "write" as const,
  };
  return Object.freeze([Object.freeze(def)]);
}
