// M6 fake Calendar CREATE write port for the browser E2E harness.
//
// Injected through the trusted `startServer({ actionCreateBinding })` seam
// (never from env/config): the capability is DERIVED from the Calendar
// instance the server itself just registered, so the exact-identity triple
// gate is satisfied without the harness ever knowing the stored id.
//
// The insert performs a REAL loopback HTTP POST against the hermetic
// Google-shaped fixture (`createFixture.ts`, served by the harness control
// server on the same loopback interface): the event actually materializes
// in fixture storage, the stable id + exact fields are validated
// fixture-side, and the POST/GET counts are recorded independent of receipt
// state. Loss simulation (`loss` mode) applies the write BEFORE the
// response is lost and returns `unknown` (never a throw across the worker
// boundary, never a resend); a 409 proves no overwrite (`definite_failure`).

import type { CalendarCreateWritePort } from "@companion/kernel";
import type { CreateFixtureStore } from "./createFixture.js";
import { CALENDAR_CONTROL_ORIGIN, FIXTURE_CREATE_PATH } from "./ports.js";

export function createFakeCalendarCreateWritePort(
  store: CreateFixtureStore,
  connectorInstanceId: string,
): CalendarCreateWritePort {
  return {
    capability: {
      tool: "calendar.create",
      editableFields: ["title", "start", "end"],
      connectorInstanceId,
      writeEnabled: true,
    },
    async insert(request) {
      // Single POST per committed grant: the real committed-gate boundary is
      // the only caller, so this fetch IS the observable external insert.
      let res: Response;
      try {
        res = await fetch(`${CALENDAR_CONTROL_ORIGIN}${FIXTURE_CREATE_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(request.account !== undefined
              ? { "x-fixture-account": request.account }
              : {}),
          },
          body: JSON.stringify({
            id: request.stableEventId,
            summary: request.title,
            start: { dateTime: request.start },
            end: { dateTime: request.end },
          }),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
          redirect: "manual",
        });
      } catch {
        // Transport loss (socket close/abort/disconnect) AFTER a possible
        // dispatch: never a definite claim, never a resend from here.
        return { status: "unknown" };
      }
      if (res.status === 409) {
        return { status: "definite_failure" };
      }
      if (!res.ok) {
        return { status: "unknown" };
      }
      if (store.mode === "loss") {
        // The fixture stored the event BEFORE this response was lost: the
        // write happened, the proof did not. Plain `unknown`, no resend,
        // no read-to-resolve from this port (the strategy owns that rule).
        return { status: "unknown" };
      }
      return { status: "succeeded" };
    },
  };
}
