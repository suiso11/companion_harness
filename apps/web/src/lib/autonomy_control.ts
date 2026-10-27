/// <reference lib="dom" />
// Shared autonomy pause-control contract (autonomy panel + paused banner).
//
// The server re-applies the pause fence on every restart by design, so both
// surfaces must read the SAME snapshot (`GET /api/autonomy/control`) and
// resume through the SAME CAS + Idempotency-Key request. Keeping the request
// building here avoids two subtly different pause protocols in the UI.
import { type ApiResult, fetchJson, postJson } from "./api.js";

export const AUTONOMY_CONTROL_PATH = "/api/autonomy/control";

export interface AutonomyControlSnapshot {
  readonly paused: boolean;
  readonly version: number;
}

/** Structural guard: malformed bodies are unknown, never "running". */
export function parseAutonomyControl(
  body: unknown,
): AutonomyControlSnapshot | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as { paused?: unknown; version?: unknown };
  if (typeof row.paused !== "boolean" || typeof row.version !== "number") {
    return null;
  }
  return { paused: row.paused, version: row.version };
}

export async function fetchAutonomyControl(): Promise<AutonomyControlSnapshot | null> {
  const result = await fetchJson(AUTONOMY_CONTROL_PATH);
  if (result.status !== 200) return null;
  return parseAutonomyControl(result.body);
}

/** Frozen CAS body used by both the panel and the banner resume button. */
export function buildControlBody(
  paused: boolean,
  expectedVersion: number,
): { paused: boolean; expectedVersion: number } {
  return { paused, expectedVersion };
}

/**
 * POST the control change with an explicit Idempotency-Key. Callers reuse the
 * SAME key while the outcome is uncertain (network / 5xx), exactly like the
 * autonomy panel's frozen command.
 */
export async function postAutonomyControl(
  paused: boolean,
  expectedVersion: number,
  key: string,
): Promise<ApiResult> {
  return postJson(
    AUTONOMY_CONTROL_PATH,
    buildControlBody(paused, expectedVersion),
    key,
  );
}

/** Banner visibility mapping: only a valid paused snapshot shows it. */
export type AutonomyBannerState = "paused" | "running" | "unknown";

export function autonomyBannerState(
  snapshot: AutonomyControlSnapshot | null,
): AutonomyBannerState {
  if (snapshot === null) return "unknown";
  return snapshot.paused ? "paused" : "running";
}
