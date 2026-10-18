// M6 dedicated Harness create binding (optional, disabled by default).
//
// Host-owned factory that builds the DEDICATED `CalendarCreateWritePort`
// for the `StartServerOptions.actionCreateBinding` seam in `bootstrap.ts`.
// It connects the kernel-approved `calendar.create` execution to the
// SEPARATE create MCP entrypoint (`google-calendar-create` /
// `1.0.0-create.1`, tool `create-event` only) through
// `createCreateWritePort`.
//
// Trust class (separate from the readonly allowlist AND the reschedule
// binding):
// - This binding is NEVER registered on the readonly entrypoint and never
//   enters the read allowlist; the readonly surface keeps zero write tools.
//   It is equally separate from the reschedule entrypoint/binding: neither
//   binding can ever be substituted for the other (exact tool-name gates on
//   both ports fail closed).
// - The caller MUST be a dedicated create MCP connection whose configured
//   upstream tool is exactly `create-event` (any other name is refused).
// - The stable insert id is derived hostside from the IMMUTABLE execution
//   id (32 lowercase hex, never model input); one consumed grant performs
//   exactly one insert with it. A 409/already-exists is a definite failure
//   with NO overwrite, NO retry, NO resend.
// - Shared persisted write-grant namespace: the dedicated caller
//   authorizes from the SAME `M5_RESCHEDULE_*` grant file + account +
//   OAuth client as reschedule (scope-identical, no separate `M6_CREATE_*`
//   credential namespace); readonly tokens are never reused. No OAuth
//   flow is invoked here and no scope is broadened at runtime.
// - All defaults disabled: merely importing this module enables nothing.
//   The port becomes live only when the host passes it as
//   `actionCreateBinding` AND `config.actions.optIn` + `writeEnabled` +
//   `createEnabled` are all true AND its capability names the active
//   Calendar instance (bootstrap gate) AND an active Calendar composition
//   exists. Old reschedule-only compositions never autocreate: without the
//   explicit `createEnabled` flag and this binding, no `calendar.create`
//   registration, strategy seam, or external insert exists.

import {
  CREATE_WRITE_TOOL,
  type CreateWriteCaller,
  type CreateWriteTarget,
  createCreateWritePort,
} from "@companion/connector-calendar";
import type { CalendarCreateWritePort } from "@companion/kernel";
import type { ActionCreateBinding } from "./bootstrap.js";

export type { CreateWriteCaller, CreateWriteTarget };

export interface CreateDedicatedCreateBindingOptions {
  /**
   * Dedicated create MCP caller (own connection to the separate create
   * entrypoint; never the readonly connector, never the reschedule
   * connector).
   */
  readonly caller: CreateWriteCaller;
  /**
   * Lifecycle ownership transfer to the server (default false: caller-owned,
   * never closed by the server). Passed through to `ActionCreateBinding`.
   */
  readonly owned?: boolean;
  /** Optional close hook; used only together with `owned === true`. */
  readonly shutdown?: () => Promise<void>;
}

/**
 * Build the host-owned dedicated create binding for the create seam.
 * Pure construction (no I/O, no OAuth, no scope change). The port is derived
 * from the EXACT active Calendar instance the server registers, so the
 * bootstrap exact-identity check still fails closed on any mismatch.
 */
export function createDedicatedCreateBinding(
  options: CreateDedicatedCreateBindingOptions,
): ActionCreateBinding {
  return {
    ...(options.owned !== undefined ? { owned: options.owned } : {}),
    ...(options.shutdown !== undefined ? { shutdown: options.shutdown } : {}),
    derivePort: (active) => {
      const port = createCreateWritePort({
        connectorInstanceId: active.connectorInstanceId,
        caller: options.caller,
        upstreamTool: CREATE_WRITE_TOOL,
      });
      return port as unknown as CalendarCreateWritePort;
    },
  };
}
