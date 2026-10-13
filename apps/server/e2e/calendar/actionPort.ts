// C22 fake Calendar WRITE port for the browser Action harness.
//
// Injected through the trusted `startServer({ actionWriteBinding })` seam
// (never from env/config): the capability is DERIVED from the Calendar
// instance the server itself registered, so the exact-identity triple gate
// is satisfied without the harness ever knowing the stored instance id.
//
// Behavior is fully scripted by the loopback control server
// (`/arm-write`, `/release`, `/status`): the fake upstream state is mutated
// only by the writes that actually pass the real committed grant gate, so
// the browser spec observes real upstream deltas and real read-backs.

import { CALENDAR_RESCHEDULE_TOOL_NAME } from "@companion/contracts";
import type {
  CalendarActionWritePort,
  CalendarWriteOutcome,
} from "@companion/kernel";
import type { FakeCalendarState } from "./mcpFake.js";

export function createFakeCalendarActionWritePort(
  state: FakeCalendarState,
  connectorInstanceId: string,
): CalendarActionWritePort {
  return {
    capability: {
      tool: CALENDAR_RESCHEDULE_TOOL_NAME,
      editableFields: ["start", "end"],
      connectorInstanceId,
      writeEnabled: true,
    },
    async update(request): Promise<CalendarWriteOutcome> {
      // Counts only AFTER the real committed gate reached the port: this is
      // the observable "exactly one external write" signal.
      state.writeCalls += 1;
      if (state.writeMode === "failure") {
        return { status: "definite_failure" };
      }
      if (state.writeMode === "unknown") {
        return { status: "unknown" };
      }
      if (state.writeMode !== "unverified") {
        // The write really landed upstream: the authoritative read-back that
        // follows can verify the intended boundaries.
        state.startOverride = request.start;
        state.endOverride = request.end;
      }
      if (state.writeMode === "barrier") {
        await new Promise<void>((resolve) => {
          state.releaseWrite = resolve;
        });
      }
      return { status: "succeeded" };
    },
  };
}
