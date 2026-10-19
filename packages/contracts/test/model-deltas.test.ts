// PR-2 ephemeral model deltas: additive SSE-only types, durable registries
// untouched (LATEST stays 20 closed types; pages reject delta names).
import { describe, expect, it } from "vitest";
import {
  ANSWER_DRAFT_DELTA_EVENT_TYPE,
  AnswerDraftDeltaPayloadSchema,
  LATEST_RUN_EVENT_TYPES,
  LatestEventsResponseSchema,
  LatestRunEventSchema,
  M2RunEventSchema,
  MODEL_DELTA_EVENT_TYPES,
  MODEL_REASONING_DELTA_EVENT_TYPE,
  MODEL_USAGE_EVENT_TYPE,
  ModelDeltaEventSchema,
  ModelReasoningDeltaPayloadSchema,
  ModelUsageDeltaPayloadSchema,
  parseModelDeltaEvent,
  parseModelDeltaEventPayload,
  parseRunEvent,
} from "../src/events.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

function deltaEnvelope(type: string, payload: unknown): unknown {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    seq: 0,
    createdAt: Date.now(),
    type,
    payload,
  };
}

describe("ephemeral model deltas (PR-2)", () => {
  it("exposes exactly the three additive delta names", () => {
    expect([...MODEL_DELTA_EVENT_TYPES].sort()).toEqual(
      ["answer.draft.delta", "model.reasoning.delta", "model.usage"].sort(),
    );
  });

  it("parses valid delta envelopes and payloads", () => {
    expect(
      parseModelDeltaEvent(
        deltaEnvelope(MODEL_REASONING_DELTA_EVENT_TYPE, {
          step: 1,
          text: "thinking…",
        }),
      ).type,
    ).toBe("model.reasoning.delta");
    expect(
      parseModelDeltaEvent(
        deltaEnvelope(ANSWER_DRAFT_DELTA_EVENT_TYPE, {
          step: 2,
          text: "draft suffix",
        }),
      ).type,
    ).toBe("answer.draft.delta");
    expect(
      parseModelDeltaEvent(
        deltaEnvelope(MODEL_USAGE_EVENT_TYPE, {
          promptTokens: 10,
          completionTokens: 45,
          elapsedMs: 2800,
        }),
      ).type,
    ).toBe("model.usage");
    expect(
      parseModelDeltaEventPayload("model.reasoning.delta", {
        step: 1,
        text: "x",
      }),
    ).toEqual({ step: 1, text: "x" });
  });

  it("rejects empty text, bad steps, and extra keys (strict)", () => {
    expect(() =>
      ModelReasoningDeltaPayloadSchema.parse({ step: 1, text: "" }),
    ).toThrow();
    expect(() =>
      AnswerDraftDeltaPayloadSchema.parse({ step: 0, text: "x" }),
    ).toThrow();
    expect(() =>
      AnswerDraftDeltaPayloadSchema.parse({ step: 9, text: "x" }),
    ).toThrow();
    expect(() =>
      ModelUsageDeltaPayloadSchema.parse({
        promptTokens: 1,
        completionTokens: 2,
        elapsedMs: -1,
      }),
    ).toThrow();
    expect(() =>
      parseModelDeltaEvent(
        deltaEnvelope(MODEL_REASONING_DELTA_EVENT_TYPE, {
          step: 1,
          text: "x",
          surprise: true,
        }),
      ),
    ).toThrow();
    // Persisted seq values are never valid delta envelopes.
    expect(() =>
      parseModelDeltaEvent({
        schemaVersion: 1,
        runId: RUN_ID,
        seq: 7,
        createdAt: Date.now(),
        type: MODEL_REASONING_DELTA_EVENT_TYPE,
        payload: { step: 1, text: "x" },
      }),
    ).toThrow();
  });

  it("keeps durable registries closed: deltas are not persisted types", () => {
    expect(LATEST_RUN_EVENT_TYPES).toHaveLength(20);
    for (const type of MODEL_DELTA_EVENT_TYPES) {
      const envelope = deltaEnvelope(type, {});
      expect(() => parseRunEvent(envelope)).toThrow();
      expect(() => M2RunEventSchema.parse(envelope)).toThrow();
      expect(() =>
        LatestRunEventSchema.parse({ ...(envelope as object), seq: 1 }),
      ).toThrow();
      expect(() =>
        LatestEventsResponseSchema.parse({
          events: [{ ...(envelope as object), seq: 1 }],
          nextAfter: 1,
          hasMore: false,
          terminal: false,
        }),
      ).toThrow();
    }
    // And the delta registry rejects every durable name.
    expect(() =>
      ModelDeltaEventSchema.parse(
        deltaEnvelope("run.completed", { result: {} }),
      ),
    ).toThrow();
  });
});
