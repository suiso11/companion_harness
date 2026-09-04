import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  ApiErrorCodeSchema,
  CancelRunRequestSchema,
  CreateSessionRequestSchema,
  EventsQuerySchema,
  EventsResponseSchema,
  FrozenContextSchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  IdempotencyKeySchema,
  IdempotencyLookupQuerySchema,
  IdempotencyLookupResponseSchema,
  IdempotencyScopeSchema,
  isActiveStatus,
  isTerminalStatus,
  M0_RUN_ERROR_CODES,
  M0_RUN_EVENT_TYPES,
  M0_TOOL_ERROR_CODES,
  messageScope,
  PostMessageRequestSchema,
  parseRunErrorCode,
  parseRunEvent,
  parseToolErrorCode,
  parseTurnInput,
  RUN_ERROR_CODE_REGISTRY,
  RunErrorCodeSchema,
  RunEventSchema,
  retryScope,
  SessionParamsSchema,
  TERMINAL_EVENT_TYPES,
  TERMINAL_STATUSES,
  TOOL_ERROR_CODE_REGISTRY,
  ToolDescriptorSchema,
  ToolErrorCodeSchema,
  ToolResultSchema,
  TurnInputV1Schema,
  UuidSchema,
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_UPPER = "123E4567-E89B-42D3-A456-426614174000";
const UUID_V1 = "123e4567-e89b-12d3-a456-426614174000";
const UUID_V7 = "01934abc-def7-7abc-8abc-426614174000";
const UUID_NIL = "00000000-0000-0000-0000-000000000000";

function envelope(
  type: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    runId: UUID,
    seq: 1,
    createdAt: 1790000000000,
    type,
    payload,
    ...extra,
  };
}

describe("TurnInput closed registry (M0: user_text v1 only)", () => {
  it("accepts the single M0 variant", () => {
    expect(
      parseTurnInput({ kind: "user_text", version: 1, text: "hello" }),
    ).toEqual({
      kind: "user_text",
      version: 1,
      text: "hello",
    });
  });

  it("rejects unknown kinds, versions, and M5 variants", () => {
    expect(() =>
      TurnInputV1Schema.parse({
        kind: "action_approval",
        version: 1,
        proposalId: UUID,
      }),
    ).toThrow();
    expect(() =>
      parseTurnInput({ kind: "user_text", version: 2, text: "hi" }),
    ).toThrow();
    expect(() =>
      parseTurnInput({ kind: "user_text", text: "no version" }),
    ).toThrow();
  });

  it("rejects blank, empty, oversized, and non-string text", () => {
    for (const text of ["", "   ", "x".repeat(32_769), 42, null]) {
      expect(() =>
        TurnInputV1Schema.parse({ kind: "user_text", version: 1, text }),
      ).toThrow();
    }
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      TurnInputV1Schema.parse({
        kind: "user_text",
        version: 1,
        text: "hi",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("RunStatus terminal/active sets", () => {
  it("has the exact agreed membership", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["abandoned", "cancelled", "completed", "failed"].sort(),
    );
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      ["cancel_requested", "queued", "running"].sort(),
    );
  });

  it("guards agree with the sets", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isActiveStatus("cancel_requested")).toBe(true);
    expect(isActiveStatus("abandoned")).toBe(false);
  });
});

describe("RunEvent closed registry (schemaVersion=1, exactly 9 types)", () => {
  it("lists exactly the M0 types", () => {
    expect([...M0_RUN_EVENT_TYPES].sort()).toEqual(
      [
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "run.abandoned",
        "tool.requested",
        "tool.completed",
      ].sort(),
    );
    expect(M0_RUN_EVENT_TYPES).toHaveLength(9);
  });

  it("parses every M0 type with its exact payload", () => {
    const cases: Array<[string, unknown]> = [
      ["run.queued", { attempt: 1 }],
      ["run.started", { attempt: 2 }],
      ["run.cancel_requested", {}],
      ["run.completed", { result: { version: 1, text: "done" } }],
      ["run.failed", { errorCode: "execution_failed" }],
      ["run.cancelled", {}],
      ["run.abandoned", { cause: "restart_recovery" }],
      [
        "tool.requested",
        {
          callId: UUID,
          callIndex: 1,
          tool: "markdown.search",
          argsHash: "a".repeat(64),
        },
      ],
      [
        "tool.completed",
        {
          callId: UUID,
          callIndex: 1,
          tool: "markdown.search",
          actualOutcome: "succeeded",
          reportedOutcome: "succeeded",
          disposition: "accepted",
          errorCode: null,
          resultDigest: "b".repeat(64),
          reusedFromCallId: null,
        },
      ],
    ];
    for (const [type, payload] of cases) {
      expect(parseRunEvent(envelope(type, payload)).type).toBe(type);
    }
  });

  it("only run.completed carries a RunResult", () => {
    const result = { version: 1, text: "done" };
    for (const type of M0_RUN_EVENT_TYPES) {
      if (type === "run.completed") continue;
      const payload =
        type === "run.queued" || type === "run.started"
          ? { attempt: 1, result }
          : { result };
      expect(() => parseRunEvent(envelope(type, payload))).toThrow();
    }
    // run.completed without a result is rejected too
    expect(() => parseRunEvent(envelope("run.completed", {}))).toThrow();
  });

  it("explicitly rejects answer.committed and assistant.delta", () => {
    for (const type of ["answer.committed", "assistant.delta"]) {
      expect(() => parseRunEvent(envelope(type, { text: "x" }))).toThrow();
      expect(() => parseRunEvent(envelope(type, {}))).toThrow();
    }
  });

  it("rejects wrong schemaVersion, bad seq, and unknown envelope keys", () => {
    expect(() =>
      parseRunEvent(
        envelope("run.queued", { attempt: 1 }, { schemaVersion: 2 }),
      ),
    ).toThrow();
    expect(() =>
      parseRunEvent(envelope("run.queued", { attempt: 1 }, { seq: 0 })),
    ).toThrow();
    expect(() =>
      RunEventSchema.parse({
        ...envelope("run.queued", { attempt: 1 }),
        surprise: true,
      }),
    ).toThrow();
  });

  it("terminal event set matches terminal statuses", () => {
    expect([...TERMINAL_EVENT_TYPES].sort()).toEqual(
      ["run.abandoned", "run.cancelled", "run.completed", "run.failed"].sort(),
    );
  });
});

describe("defaults and bounds", () => {
  it("history query defaults limit 50 and caps at 100", () => {
    expect(HistoryQuerySchema.parse({}).limit).toBe(50);
    expect(HistoryQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(() => HistoryQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => HistoryQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it("events query defaults after 0 / limit 50", () => {
    expect(EventsQuerySchema.parse({})).toMatchObject({ after: 0, limit: 50 });
    expect(() => EventsQuerySchema.parse({ after: -1 })).toThrow();
  });

  it("empty responses keep the request cursor (nextAfter == after)", () => {
    const page = EventsResponseSchema.parse({
      events: [],
      nextAfter: 7,
      hasMore: false,
      terminal: true,
    });
    expect(page.nextAfter).toBe(7);
  });

  it("history response caps items at 100", () => {
    const item = {
      turnId: UUID,
      seq: 1,
      kind: "user_text",
      text: "hi",
      createdAt: 1,
      selectedRun: null,
    };
    expect(
      HistoryResponseSchema.parse({
        items: [item],
        nextBefore: null,
        hasMore: false,
      }).items,
    ).toHaveLength(1);
    expect(() =>
      HistoryResponseSchema.parse({
        items: Array.from({ length: 101 }, () => item),
        nextBefore: null,
        hasMore: true,
      }),
    ).toThrow();
  });
});

describe("API boundaries are strict", () => {
  it("rejects unknown keys on message/session requests", () => {
    expect(() =>
      PostMessageRequestSchema.parse({ text: "hi", bogus: 1 }),
    ).toThrow();
    expect(() => PostMessageRequestSchema.parse({ text: "" })).toThrow();
    expect(() =>
      CreateSessionRequestSchema.parse({ timeZone: "UTC" }),
    ).toThrow();
  });

  it("validates idempotency keys as UUIDs", () => {
    expect(() => IdempotencyKeySchema.parse("not-a-uuid")).toThrow();
    expect(IdempotencyKeySchema.parse(UUID)).toBe(UUID);
  });

  it("fixes API error codes to the lowercase closed set", () => {
    for (const code of [
      "validation_error",
      "not_found",
      "idempotency_key_reused",
      "session_busy",
      "server_shutting_down",
      "internal_error",
    ]) {
      expect(ApiErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(() => ApiErrorCodeSchema.parse("InternalError")).toThrow();
    expect(() => ApiErrorCodeSchema.parse("server_error")).toThrow();
  });

  it("idempotency lookup is a closed found/resend union", () => {
    expect(
      IdempotencyLookupResponseSchema.parse({
        found: false,
        code: "resend_required",
      }),
    ).toBeTruthy();
    expect(() =>
      IdempotencyLookupResponseSchema.parse({ found: false, code: "retry" }),
    ).toThrow();
  });

  it("frozen context requires shaped timeZone and strict keys", () => {
    expect(
      FrozenContextSchema.parse({
        version: 1,
        temporal: { now: 1, timeZone: "Asia/Tokyo" },
      }).uiContext,
    ).toEqual({});
    expect(() =>
      FrozenContextSchema.parse({
        version: 1,
        temporal: { now: 1, timeZone: "not a zone" },
      }),
    ).toThrow();
    expect(() =>
      FrozenContextSchema.parse({
        version: 1,
        temporal: { now: 1, timeZone: "UTC" },
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("ToolDescriptor is serializable and closed", () => {
  const descriptor = {
    name: "markdown.search",
    version: 1,
    title: "Search markdown",
    description: "Reads local markdown files.",
    category: "read",
  };

  it("applies timeout defaults and JSON round-trips", () => {
    const parsed = ToolDescriptorSchema.parse(descriptor);
    expect(parsed.defaultTimeoutMs).toBe(15_000);
    expect(parsed.maxTimeoutMs).toBe(60_000);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    for (const value of Object.values(parsed)) {
      expect(typeof value === "function").toBe(false);
    }
  });

  it("rejects handlers, schemas, unknown categories, and bad names", () => {
    expect(() =>
      ToolDescriptorSchema.parse({ ...descriptor, handler: () => {} }),
    ).toThrow();
    expect(() =>
      ToolDescriptorSchema.parse({ ...descriptor, category: "unknown" }),
    ).toThrow();
    expect(() =>
      ToolDescriptorSchema.parse({ ...descriptor, name: "Bad Name" }),
    ).toThrow();
    expect(() =>
      ToolDescriptorSchema.parse({ ...descriptor, name: "nonamespaced" }),
    ).toThrow();
  });

  it("forces lowercase error codes, never raw text", () => {
    expect(ToolErrorCodeSchema.parse("budget_exceeded")).toBe(
      "budget_exceeded",
    );
    for (const bad of [
      "BudgetExceeded",
      "TOOL_FAILED",
      "has space",
      "semi;colon",
      "",
    ]) {
      expect(() => ToolErrorCodeSchema.parse(bad)).toThrow();
    }
  });

  it("closes the tool vocabulary to exactly the 9 M0 broker codes", () => {
    expect([...M0_TOOL_ERROR_CODES].sort()).toEqual(
      [
        "budget_exceeded",
        "unknown_tool",
        "tool_denied",
        "invalid_input",
        "execution_timeout",
        "execution_cancelled",
        "execution_failed",
        "output_invalid",
        "output_too_large",
      ].sort(),
    );
    expect(M0_TOOL_ERROR_CODES).toHaveLength(9);
    for (const code of M0_TOOL_ERROR_CODES) {
      expect(parseToolErrorCode(code)).toBe(code);
    }
    expect(TOOL_ERROR_CODE_REGISTRY[1]).toBe(ToolErrorCodeSchema);
    for (const bad of [
      "made_up_code",
      "custom_error",
      "server_error",
      "retry_later",
    ]) {
      expect(() => ToolErrorCodeSchema.parse(bad)).toThrow();
      expect(() => parseToolErrorCode(bad)).toThrow();
    }
  });

  it("closes the Run vocabulary to exactly execution_failed/cancelled + output_invalid", () => {
    expect([...M0_RUN_ERROR_CODES].sort()).toEqual(
      ["execution_cancelled", "execution_failed", "output_invalid"].sort(),
    );
    expect(M0_RUN_ERROR_CODES).toHaveLength(3);
    for (const code of M0_RUN_ERROR_CODES) {
      expect(RunErrorCodeSchema.parse(code)).toBe(code);
      expect(parseRunErrorCode(code)).toBe(code);
    }
    expect(RUN_ERROR_CODE_REGISTRY[1]).toBe(RunErrorCodeSchema);
    for (const bad of [
      "made_up_code",
      "budget_exceeded",
      "unknown_tool",
      "tool_denied",
      "invalid_input",
      "execution_timeout",
      "output_too_large",
    ]) {
      expect(() => RunErrorCodeSchema.parse(bad)).toThrow();
      expect(() => parseRunErrorCode(bad)).toThrow();
    }
  });

  it("rejects made_up_code in run.failed, tool.completed, and ToolResult", () => {
    expect(() =>
      parseRunEvent(envelope("run.failed", { errorCode: "made_up_code" })),
    ).toThrow();
    expect(() =>
      parseRunEvent(
        envelope("tool.completed", {
          callId: UUID,
          callIndex: 1,
          tool: "markdown.search",
          actualOutcome: "failed",
          reportedOutcome: "failed",
          disposition: "none",
          errorCode: "made_up_code",
          resultDigest: null,
          reusedFromCallId: null,
        }),
      ),
    ).toThrow();
    expect(() =>
      ToolResultSchema.parse({
        tool: "markdown.search",
        callIndex: 1,
        actualOutcome: "failed",
        reportedOutcome: "failed",
        disposition: "none",
        errorCode: "made_up_code",
        resultDigest: null,
        reusedFromCallId: null,
        finishedAt: 1,
      }),
    ).toThrow();
  });
});

describe("UUID v4 and idempotency scopes are exact", () => {
  it("accepts UUID v4 in either case", () => {
    expect(UuidSchema.parse(UUID)).toBe(UUID);
    expect(UuidSchema.parse(UUID_UPPER)).toBe(UUID_UPPER);
    expect(IdempotencyKeySchema.parse(UUID)).toBe(UUID);
  });

  it("rejects UUID v1/v7/nil and malformed ids everywhere", () => {
    for (const bad of [UUID_V1, UUID_V7, UUID_NIL, "not-a-uuid", "", "1234"]) {
      expect(() => UuidSchema.parse(bad)).toThrow();
      expect(() => IdempotencyKeySchema.parse(bad)).toThrow();
      expect(() => SessionParamsSchema.parse({ sessionId: bad })).toThrow();
    }
  });

  it("accepts only the three exact scopes with UUID v4 parent ids", () => {
    expect(IdempotencyScopeSchema.parse("sessions:create")).toBe(
      "sessions:create",
    );
    expect(IdempotencyScopeSchema.parse(messageScope(UUID))).toBe(
      `session:${UUID}:message`,
    );
    expect(IdempotencyScopeSchema.parse(retryScope(UUID))).toBe(
      `turn:${UUID}:retry`,
    );
    expect(IdempotencyScopeSchema.parse(`session:${UUID_UPPER}:message`)).toBe(
      `session:${UUID_UPPER}:message`,
    );
  });

  it("rejects malformed scope ids and unknown scopes", () => {
    expect(() => messageScope(UUID_V1)).toThrow();
    expect(() => retryScope(UUID_NIL)).toThrow();
    for (const bad of [
      `session:${UUID_V1}:message`,
      `turn:${UUID_V7}:retry`,
      `session:${UUID_NIL}:message`,
      "session:not-a-uuid:message",
      "turn::retry",
      "session::message",
      `session:${UUID}:message:extra`,
      `session:${UUID}`,
      "sessions:create:extra",
      "other:scope",
      "",
    ]) {
      expect(() => IdempotencyScopeSchema.parse(bad)).toThrow();
    }
  });

  it("binds the idempotency lookup query to the closed scope set", () => {
    expect(
      IdempotencyLookupQuerySchema.parse({ scope: "sessions:create" }),
    ).toBeTruthy();
    expect(
      IdempotencyLookupQuerySchema.parse({ scope: messageScope(UUID) }),
    ).toBeTruthy();
    expect(() =>
      IdempotencyLookupQuerySchema.parse({ scope: "made_up:scope" }),
    ).toThrow();
    expect(() =>
      IdempotencyLookupQuerySchema.parse({
        scope: `session:${UUID_V1}:message`,
      }),
    ).toThrow();
  });

  it("keeps the cancel body strictly empty", () => {
    expect(CancelRunRequestSchema.parse({})).toEqual({});
    for (const bad of [[], 5, "x", null, { unknown: 1 }, { extra: 1 }]) {
      expect(() => CancelRunRequestSchema.parse(bad)).toThrow();
    }
  });

  it("rejects unknown query keys strictly", () => {
    expect(() => HistoryQuerySchema.parse({ limit: 10, bogus: 1 })).toThrow();
    expect(() => EventsQuerySchema.parse({ after: 0, extra: 1 })).toThrow();
    expect(() =>
      IdempotencyLookupQuerySchema.parse({
        scope: "sessions:create",
        other: 1,
      }),
    ).toThrow();
  });
});
