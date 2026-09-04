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
export const ACTIVE_STATUSES = ["queued", "running", "cancel_requested"] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export const ActiveStatusSchema = z.enum(ACTIVE_STATUSES);

export function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isActiveStatus(status: RunStatus): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
