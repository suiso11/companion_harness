// M5 dedicated Harness write binding (optional, disabled by default).
//
// Host-owned factory that builds the DEDICATED `CalendarActionWritePort`
// for the existing triple-gate seam (`StartServerOptions.actionWriteBinding`
// in `bootstrap.ts`). It connects the kernel-approved
// `calendar.reschedule` execution to the SEPARATE reschedule MCP entrypoint
// (`google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
// `reschedule-event` only) through `createRescheduleWritePort`.
//
// Trust class (separate from the readonly allowlist):
// - This binding is NEVER registered on the readonly entrypoint and never
//   enters the read allowlist; the readonly surface keeps zero write tools.
// - The caller MUST be a dedicated write MCP connection whose configured
//   upstream tool is exactly `reschedule-event` (any other name is refused)
//   and whose wire identity is the dedicated write identity.
// - The etag resolver MUST return the EXACT opaque etag from the COMMITTED
//   proposal (`expectedRevision`); hash/updated-only revisions resolve to
//   null (safe definite rejection, no fresh preflight substitution).
// - Separate credential/token namespace: only `M5_RESCHEDULE_*` credentials
//   may back the dedicated caller; readonly tokens are never reused. No
//   OAuth flow is invoked here and no scope is broadened at runtime.
// - All defaults disabled: merely importing this module enables nothing.
//   The port becomes live only when the host passes it as
//   `actionWriteBinding` AND `config.actions.optIn` + `writeEnabled` are true
//   AND its capability names the active Calendar instance (bootstrap gate).

import {
  createRescheduleWritePort,
  RESCHEDULE_WRITE_TOOL,
  type RescheduleWriteCaller,
  type RescheduleWriteTarget,
  type ResolveExpectedEtag,
} from "@companion/connector-calendar";
import type { CalendarActionWritePort } from "@companion/kernel";
import type { ActionWriteBinding } from "./bootstrap.js";

export type { RescheduleWriteCaller, RescheduleWriteTarget };

export interface CreateDedicatedWriteBindingOptions {
  /**
   * Dedicated write MCP caller (own connection to the separate
   * reschedule entrypoint; never the readonly connector).
   */
  readonly caller: RescheduleWriteCaller;
  /**
   * Committed-grant etag resolution, keyed by the EXACT committed grant
   * (execution + proposal + hash + `expectedRevision`; never the current
   * resource alone). Returns the exact proposal `expectedRevision` etag,
   * or null for hash/updated-only revisions.
   */
  readonly resolveExpectedEtag: ResolveExpectedEtag;
  /**
   * Lifecycle ownership transfer to the server (default false: caller-owned,
   * never closed by the server). Passed through to `ActionWriteBinding`.
   */
  readonly owned?: boolean;
  /** Optional close hook; used only together with `owned === true`. */
  readonly shutdown?: () => Promise<void>;
}

/**
 * Build the host-owned dedicated write binding for the triple-gate seam.
 * Pure construction (no I/O, no OAuth, no scope change). The port is derived
 * from the EXACT active Calendar instance the server registers, so the
 * bootstrap exact-identity check still fails closed on any mismatch.
 */
export function createDedicatedWriteBinding(
  options: CreateDedicatedWriteBindingOptions,
): ActionWriteBinding {
  return {
    ...(options.owned !== undefined ? { owned: options.owned } : {}),
    ...(options.shutdown !== undefined ? { shutdown: options.shutdown } : {}),
    derivePort: (active) => {
      const port = createRescheduleWritePort({
        connectorInstanceId: active.connectorInstanceId,
        caller: options.caller,
        upstreamTool: RESCHEDULE_WRITE_TOOL,
        resolveExpectedEtag: options.resolveExpectedEtag,
      });
      return port as unknown as CalendarActionWritePort;
    },
  };
}
