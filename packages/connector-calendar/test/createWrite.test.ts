// M6 dedicated create port: SELF-CONTAINED behavior tests (no fork, no net).
//
// Exercises the REAL Harness port (`createCreateWritePort`) against a
// fake single-attempt caller: exact one-call body shape, 1 grant -> 1 POST,
// 409 definite with no resend, transport loss -> unknown, wrong tool / bad
// id / bad grant -> definite_failure. No live Google, no OAuth.

import { describe, expect, it } from "vitest";
import {
  CREATE_WRITE_TOOL,
  createCreateWritePort,
} from "../src/createWrite.js";

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const EXECUTION = "22222222-2222-4222-8222-222222222222";
const STABLE = EXECUTION.replace(/-/g, "").toLowerCase();
const TITLE = "Team sync";
const START = "2026-03-01T10:00:00Z";
const END = "2026-03-01T11:00:00Z";

function baseRequest() {
  return {
    grant: {
      executionId: EXECUTION,
      proposalId: "33333333-3333-4333-8333-333333333333",
      proposalHash: "a".repeat(64),
      tool: "calendar.create" as const,
      inputHash: "b".repeat(64),
      expectedRevision: null,
    },
    connectorInstanceId: INSTANCE,
    tool: "calendar.create" as const,
    title: TITLE,
    start: START,
    end: END,
    stableEventId: STABLE,
    calendarId: "primary",
  };
}

describe("create write port (M6)", () => {
  it("performs exactly one create-event call with the body-only shape", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async (upstreamTool: string, args: unknown) => {
          calls.push({ tool: upstreamTool, args });
          return {
            ok: true as const,
            structuredContent: { status: "succeeded" },
          };
        },
      },
    });
    const outcome = await port.insert(baseRequest());
    expect(outcome).toEqual({ status: "succeeded" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe(CREATE_WRITE_TOOL);
    const args = calls[0]?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(
      ["account", "calendarId", "end", "id", "start", "summary"]
        .sort()
        .filter((k) => k !== "account" || "account" in args),
    );
    expect(args.id).toBe(STABLE);
    expect(args.summary).toBe(TITLE);
    expect(args.start).toBe(START);
    expect(args.end).toBe(END);
    expect("description" in args).toBe(false);
    expect("attendees" in args).toBe(false);
    expect("recurrence" in args).toBe(false);
  });

  it("maps a 409/already-exists payload to definite_failure with no resend", async () => {
    let calls = 0;
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async () => {
          calls += 1;
          return {
            ok: true as const,
            structuredContent: {
              status: "definite_failure",
              code: "already_exists",
            },
          };
        },
      },
    });
    const outcome = await port.insert(baseRequest());
    expect(outcome).toEqual({ status: "definite_failure" });
    expect(calls).toBe(1);
  });

  it("maps transport loss to unknown (never definite, never resend)", async () => {
    let calls = 0;
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async () => {
          calls += 1;
          return { ok: false as const, code: "transport_lost" };
        },
      },
    });
    const outcome = await port.insert(baseRequest());
    expect(outcome).toEqual({ status: "unknown" });
    expect(calls).toBe(1);
  });

  it("refuses a throwing caller after dispatch as unknown (no resend)", async () => {
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async () => {
          throw new Error("disconnect");
        },
      },
    });
    expect(await port.insert(baseRequest())).toEqual({ status: "unknown" });
  });

  it("fails closed on instance/tool/id mismatches with zero calls", async () => {
    let calls = 0;
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async () => {
          calls += 1;
          return {
            ok: true as const,
            structuredContent: { status: "succeeded" },
          };
        },
      },
    });
    const badInstance = { ...baseRequest(), connectorInstanceId: "other" };
    expect(await port.insert(badInstance)).toEqual({
      status: "definite_failure",
    });
    const badId = { ...baseRequest(), stableEventId: "NOTHEX!!" };
    expect(await port.insert(badId)).toEqual({ status: "definite_failure" });
    const badGrant = {
      ...baseRequest(),
      grant: { ...baseRequest().grant, tool: "calendar.reschedule" as const },
    };
    expect(
      await port.insert(
        badGrant as unknown as Parameters<typeof port.insert>[0],
      ),
    ).toEqual({ status: "definite_failure" });
    expect(calls).toBe(0);
  });

  it("rejects a non-create upstream tool at construction", () => {
    expect(() =>
      createCreateWritePort({
        connectorInstanceId: INSTANCE,
        caller: { callTool: async () => ({ ok: true as const }) },
        upstreamTool: "reschedule-event",
      }),
    ).toThrow();
  });

  it("rejects U+0085 and C1 controls in the title with zero calls", async () => {
    let calls = 0;
    const port = createCreateWritePort({
      connectorInstanceId: INSTANCE,
      caller: {
        callTool: async () => {
          calls += 1;
          return {
            ok: true as const,
            structuredContent: { status: "succeeded" },
          };
        },
      },
    });
    for (const title of ["\u0085", "a\u0085b", "a\u0001b", "a\u007f"]) {
      expect(await port.insert({ ...baseRequest(), title })).toEqual({
        status: "definite_failure",
      });
    }
    expect(calls).toBe(0);
    // Valid Unicode (CJK + emoji + accents + NBSP just above the C1 range)
    // still dispatches exactly once.
    const valid = await port.insert({
      ...baseRequest(),
      title: "日本語 🎉 café \u00a0ok",
    });
    expect(valid).toEqual({ status: "succeeded" });
    expect(calls).toBe(1);
  });
});
