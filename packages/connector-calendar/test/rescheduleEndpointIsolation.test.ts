// M5 production-boundary regression (host side, no live Google).
//
// - POST-dispatch 3xx is `unknown` (mirror of the production fork adapter;
//   the PATCH was already received, no redirect follow, no resend).
// - Concrete committed-grant resolver: keyed by execution/proposal/hash,
//   exact expectedRevision + real source-etag basis, else null (no fresh
//   preflight substitution). Default OFF (explicit store only).
// - Shipped fork CLI (when the fork checkout is present) contains NO test
//   endpoint/auth bypass env; skipped clean-clone-safe when absent. No
//   network, no Google, no OAuth.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCommittedGrantResolver,
  createRescheduleWritePort,
} from "../src/rescheduleWrite.js";

const ETAG = '"etag-v1"';
const GRANT = {
  executionId: "11111111-1111-4111-8111-111111111111",
  proposalId: "22222222-2222-4222-8222-222222222222",
  proposalHash: "a".repeat(64),
};

function grantKey(): string {
  return `${GRANT.executionId}\n${GRANT.proposalId}\n${GRANT.proposalHash}`;
}

describe("host production boundary (no live Google)", () => {
  it("committed-grant resolver returns the exact etag only for the exact grant", async () => {
    const resolve = createCommittedGrantResolver(new Map([[grantKey(), ETAG]]));
    expect(resolve({ ...GRANT, expectedRevision: ETAG })).toBe(ETAG);
    // Unknown grant / revision mismatch / hash-only / updated-only -> null.
    expect(
      resolve({
        ...GRANT,
        executionId: "99999999-9999-4999-8999-999999999999",
        expectedRevision: ETAG,
      }),
    ).toBeNull();
    expect(resolve({ ...GRANT, expectedRevision: '"other"' })).toBeNull();
    expect(resolve({ ...GRANT, expectedRevision: "c".repeat(64) })).toBeNull();
    expect(
      resolve({ ...GRANT, expectedRevision: "2026-02-01T10:00:00.000Z" }),
    ).toBeNull();
  });

  it("committed-grant port dispatches with the resolver etag; mismatch is definite with no dispatch", async () => {
    let dispatched = 0;
    const port = createRescheduleWritePort({
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      caller: {
        async callTool() {
          dispatched += 1;
          return { ok: true, text: JSON.stringify({ status: "succeeded" }) };
        },
      },
      resolveExpectedEtag: createCommittedGrantResolver(
        new Map([[grantKey(), ETAG]]),
      ),
    });
    const base = {
      grant: {
        ...GRANT,
        tool: "calendar.reschedule" as const,
        inputHash: "b".repeat(64),
        expectedRevision: ETAG,
      },
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      tool: "calendar.reschedule" as const,
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      targetResourceId: "resource-1",
      targetCanonicalKey: "canon-1",
      target: { calendarId: "primary", eventId: "evt-1" },
    };
    expect(await port.update(base)).toEqual({ status: "succeeded" });
    expect(dispatched).toBe(1);
    expect(
      await port.update({
        ...base,
        grant: { ...base.grant, expectedRevision: '"stale"' },
      }),
    ).toEqual({ status: "definite_failure" });
    expect(dispatched).toBe(1);
  });

  it("shipped fork CLI (when present) has no test bypass env", () => {
    const forkCli = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      ".m5-write-fork-derived",
      "src",
      "reschedule",
      "cli.ts",
    );
    if (!existsSync(forkCli)) return;
    const source = readFileSync(forkCli, "utf-8");
    for (const flag of [
      "process.env.M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE",
      "process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE",
      "process.env.M5_RESCHEDULE_FORK_CLI",
    ]) {
      expect(source, flag).not.toContain(flag);
    }
  });
});
