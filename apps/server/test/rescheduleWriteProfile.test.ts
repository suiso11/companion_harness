// M5 dedicated write host pin: the separate write identity is pinned in
// host code, the readonly profile is never widened, and the dedicated
// binding derives its port from the ACTIVE config-owned instance.

import {
  CALENDAR_RESCHEDULE_TOOL,
  RESCHEDULE_WRITE_MCP_NAME,
  RESCHEDULE_WRITE_MCP_VERSION,
  RESCHEDULE_WRITE_TOOL,
  RESCHEDULE_WRITE_WIRE_HASH,
} from "@companion/connector-calendar";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_READONLY_TOOLS,
  getGoogleReadonlyDefinitions,
} from "../src/calendarReadonlyProfile.js";
import {
  createCommittedGrantWriteBinding,
  createDedicatedWriteBinding,
} from "../src/rescheduleWriteBinding.js";
import {
  getRescheduleWriteDefinitions,
  RESCHEDULE_WRITE_WIRE_HASH as PINNED_HASH,
  RESCHEDULE_WRITE_FORK,
  RESCHEDULE_WRITE_SERVER_NAME,
  RESCHEDULE_WRITE_SERVER_VERSION,
  RESCHEDULE_WRITE_TOOL_NAME,
} from "../src/rescheduleWriteProfile.js";

describe("dedicated reschedule write host pin", () => {
  it("pins the dedicated (never readonly) wire identity + live-wire hash", () => {
    expect(RESCHEDULE_WRITE_SERVER_NAME).toBe(RESCHEDULE_WRITE_MCP_NAME);
    expect(RESCHEDULE_WRITE_SERVER_VERSION).toBe(RESCHEDULE_WRITE_MCP_VERSION);
    expect(RESCHEDULE_WRITE_TOOL_NAME).toBe(RESCHEDULE_WRITE_TOOL);
    expect(PINNED_HASH).toBe(RESCHEDULE_WRITE_WIRE_HASH);
    expect(RESCHEDULE_WRITE_SERVER_NAME).toBe("google-calendar-reschedule");
    expect(RESCHEDULE_WRITE_SERVER_VERSION).toBe("1.0.0-reschedule.1");
    expect(RESCHEDULE_WRITE_FORK.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    // Exact write provenance pin (readonly pin untouched elsewhere).
    expect(RESCHEDULE_WRITE_FORK.baseCommit).toBe(
      "6939311fd3eae9846648e0a175e304c9500f578e",
    );
    expect(RESCHEDULE_WRITE_FORK.sourceCommit).toBe(
      "f196558e7d768effd969cf70ada2721d7d504b23",
    );
    expect(RESCHEDULE_WRITE_FORK.sourceTree).toBe(
      "b50f74550a5269ec1af4e57c6d4cc03e76a9aebd",
    );
    expect(RESCHEDULE_WRITE_FORK.lockDigestSha256).toBe(
      "63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533",
    );
  });

  it("exports exactly one trusted write definition (dedicated gate only)", () => {
    const defs = getRescheduleWriteDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      upstreamTool: "reschedule-event",
      canonicalSchemaHash: PINNED_HASH,
      category: "write",
    });
    expect(Object.isFrozen(defs)).toBe(true);
  });

  it("never widens the readonly profile (zero write tools, unchanged surface)", () => {
    expect([...GOOGLE_READONLY_TOOLS]).toEqual([
      "list-events",
      "search-events",
      "get-event",
    ]);
    const defs = getGoogleReadonlyDefinitions();
    expect(defs).toHaveLength(3);
    for (const def of defs) {
      expect(def.category).toBe("read");
      expect(def.upstreamTool).not.toBe("reschedule-event");
    }
  });

  it("derivePort is config-owned: port capability names the active instance, mismatch refused", async () => {
    const activeId = "33333333-3333-4333-8333-333333333333";
    const etag = '"etag-v1"';
    let dispatched = 0;
    const binding = createDedicatedWriteBinding({
      caller: {
        async callTool() {
          dispatched += 1;
          return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
        },
      },
      resolveExpectedEtag: () => etag,
    });
    expect(binding.derivePort).toBeDefined();
    const port = binding.derivePort?.({
      connectorInstanceId: activeId,
      calendarId: "primary",
    }) as unknown as {
      capability: { connectorInstanceId: string; tool: string };
      update: (request: {
        grant: {
          executionId: string;
          proposalId: string;
          proposalHash: string;
          tool: "calendar.reschedule";
          inputHash: string;
          expectedRevision: string;
        };
        connectorInstanceId: string;
        tool: "calendar.reschedule";
        start: string;
        end: string;
        targetResourceId: string;
        targetCanonicalKey: string;
        target: { calendarId: string; eventId: string };
      }) => Promise<{ status: string }>;
    };
    expect(port?.capability.connectorInstanceId).toBe(activeId);
    expect(port?.capability.tool).toBe(CALENDAR_RESCHEDULE_TOOL);
    const grantBase = {
      executionId: "11111111-1111-4111-8111-111111111111",
      proposalId: "22222222-2222-4222-8222-222222222222",
      proposalHash: "a".repeat(64),
      tool: "calendar.reschedule" as const,
      inputHash: "b".repeat(64),
      expectedRevision: etag,
    };
    // Mismatched instance is refused with NO dispatch.
    const refused = await port?.update({
      grant: grantBase,
      connectorInstanceId: "44444444-4444-4444-8444-444444444444",
      tool: "calendar.reschedule",
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      targetResourceId: "resource-1",
      targetCanonicalKey: "canon-1",
      target: { calendarId: "primary", eventId: "evt-1" },
    });
    expect(refused).toEqual({ status: "definite_failure" });
    expect(dispatched).toBe(0);
  });

  it("committed-grant binding resolves the exact etag; unknown/hash-only revisions never dispatch", async () => {
    const etag = '"etag-v1"';
    const grantBase = {
      executionId: "11111111-1111-4111-8111-111111111111",
      proposalId: "22222222-2222-4222-8222-222222222222",
      proposalHash: "a".repeat(64),
    };
    const key = `${grantBase.executionId}\n${grantBase.proposalId}\n${grantBase.proposalHash}`;
    let dispatched = 0;
    const binding = createCommittedGrantWriteBinding({
      caller: {
        async callTool() {
          dispatched += 1;
          return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
        },
      },
      committed: new Map([[key, etag]]),
    });
    const port = binding.derivePort?.({
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      calendarId: "primary",
    }) as unknown as {
      update: (request: {
        grant: {
          executionId: string;
          proposalId: string;
          proposalHash: string;
          tool: "calendar.reschedule";
          inputHash: string;
          expectedRevision: string;
        };
        connectorInstanceId: string;
        tool: "calendar.reschedule";
        start: string;
        end: string;
        targetResourceId: string;
        targetCanonicalKey: string;
        target: { calendarId: string; eventId: string };
      }) => Promise<{ status: string }>;
    };
    const ok = await port?.update({
      grant: {
        ...grantBase,
        tool: "calendar.reschedule",
        inputHash: "b".repeat(64),
        expectedRevision: etag,
      },
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      tool: "calendar.reschedule",
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      targetResourceId: "resource-1",
      targetCanonicalKey: "canon-1",
      target: { calendarId: "primary", eventId: "evt-1" },
    });
    expect(ok).toEqual({ status: "succeeded" });
    expect(dispatched).toBe(1);
    // Hash-only revision is rejected with no dispatch.
    const hashRev = "c".repeat(64);
    const refused = await port?.update({
      grant: {
        ...grantBase,
        tool: "calendar.reschedule",
        inputHash: "b".repeat(64),
        expectedRevision: hashRev,
      },
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      tool: "calendar.reschedule",
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      targetResourceId: "resource-1",
      targetCanonicalKey: "canon-1",
      target: { calendarId: "primary", eventId: "evt-1" },
    });
    expect(refused).toEqual({ status: "definite_failure" });
    expect(dispatched).toBe(1);
  });
});
