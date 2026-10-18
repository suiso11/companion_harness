import { z } from "zod";

/** Full M0 Run lifecycle status (§10, §11.2). */
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Terminal states: no further transition or RunEvent is possible. */
export const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export const TerminalStatusSchema = z.enum(TERMINAL_STATUSES);

/**
 * Active states: at most one Run in these states per session
 * (partial unique index, §10). `cancel_requested` counts as active.
 */
export const ACTIVE_STATUSES = [
  "queued",
  "running",
  "cancel_requested",
] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export const ActiveStatusSchema = z.enum(ACTIVE_STATUSES);

/**
 * Explicit per-run memory status (I01-06, additive): metadata only, never
 * memory content. `used` = snippets were projected into the prompt block;
 * `empty` = recall succeeded with nothing to show; `disabled` = memory not
 * configured; the failure statuses derive from the closed CLI failure codes
 * (`cli_timeout` → timeout, `cli_version_mismatch` → version_mismatch,
 * `cli_limit` → limit, `cli_unavailable`/`cli_malformed`/`cli_bad_request`
 * → unavailable). A null/absent status means the run never reached the
 * recall boundary (or predates the column). The companion continues
 * memoryless on every non-`used` status — the status makes the state
 * visible, it never fails the run.
 */
export const RunMemoryStatusSchema = z.enum([
  "used",
  "empty",
  "disabled",
  "unavailable",
  "timeout",
  "version_mismatch",
  "limit",
]);
export type RunMemoryStatus = z.infer<typeof RunMemoryStatusSchema>;

export function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isActiveStatus(status: RunStatus): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
