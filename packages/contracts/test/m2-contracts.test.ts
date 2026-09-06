import { describe, expect, it } from "vitest";
import {
  ANSWER_SUBMIT_TOOL_NAME,
  AnswerSubmitToolInputSchema,
  ApiErrorCodeSchema,
  CITATION_ID_REGEX,
  CitationIdSchema,
  EventsResponseSchema,
  isTerminalEventType,
  KNOWN_M2_MODEL_ERROR_CODES,
  LATEST_RUN_EVENT_PAYLOAD_SCHEMAS,
  LATEST_RUN_EVENT_TYPES,
  LatestEventsResponseSchema,
  LatestRunEventSchema,
  M0_RUN_ERROR_CODES,
  M0_RUN_EVENT_TYPES,
  M0_TOOL_ERROR_CODES,
  M0EventsResponseSchema,
  M0RunEventSchema,
  M1_RUN_EVENT_PAYLOAD_SCHEMAS,
  M1_RUN_EVENT_TYPES,
  M1_TOOL_ERROR_CODES,
  M1EventsResponseSchema,
  M1RunEventSchema,
  M2_MODEL_ERROR_CODE_REGISTRY,
  M2_MODEL_ERROR_CODES,
  M2_MODEL_STEP_EVENT_TYPES,
  M2_RUN_EVENT_PAYLOAD_SCHEMAS,
  M2_RUN_EVENT_TYPES,
  M2EventsResponseSchema,
  M2ModelErrorCodeSchema,
  M2ModelStepEventTypeSchema,
  M2RunEventSchema,
  MAX_CITATIONS_PER_PART,
  MAX_MODEL_STEPS_PER_RUN,
  MAX_PART_TEXT_CODE_POINTS,
  MAX_STRUCTURED_ANSWER_BYTES,
  MAX_STRUCTURED_ANSWER_PARTS,
  MIN_PART_TEXT_CODE_POINTS,
  MIN_STRUCTURED_ANSWER_PARTS,
  ModelStepCompletedPayloadSchema,
  ModelStepFailedPayloadSchema,
  ModelStepStartedPayloadSchema,
  ModelStepUsageSchema,
  measureStructuredAnswerBytes,
  parseM0RunEvent,
  parseM1RunEvent,
  parseM1RunEventPayload,
  parseM2ModelErrorCode,
  parseM2RunEvent,
  parseM2RunEventPayload,
  parseRunEvent,
  parseRunEventPayload,
  parseStructuredAnswer,
  RESERVED_ANSWER_NAMESPACE,
  RunErrorCodeSchema,
  RunResultSchema,
  STRUCTURED_ANSWER_REGISTRY,
  STRUCTURED_ANSWER_VERSION,
  StructuredAnswerPartSchema,
  StructuredAnswerSchema,
  TERMINAL_EVENT_TYPES,
  ToolErrorCodeSchema,
  utf8ByteLength,
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function envelope(type: string, payload: unknown) {
  return {
    schemaVersion: 1,
    runId: UUID,
    seq: 1,
    createdAt: 1790000000000,
    type,
    payload,
  };
}

function part(text: string, citations: string[] = []) {
  return { text, citations };
}

function answer(parts: Array<{ text: string; citations?: string[] }>) {
  return {
    version: 1 as const,
    parts: parts.map((p) => ({ text: p.text, citations: p.citations ?? [] })),
  };
}

describe("StructuredAnswer exact bounds (parts 1-20, text 1-4000, citations 0-8)", () => {
  it("fixes the agreed constants", () => {
    expect(STRUCTURED_ANSWER_VERSION).toBe(1);
    expect(MIN_STRUCTURED_ANSWER_PARTS).toBe(1);
    expect(MAX_STRUCTURED_ANSWER_PARTS).toBe(20);
    expect(MIN_PART_TEXT_CODE_POINTS).toBe(1);
    expect(MAX_PART_TEXT_CODE_POINTS).toBe(4000);
    expect(MAX_CITATIONS_PER_PART).toBe(8);
    expect(MAX_STRUCTURED_ANSWER_BYTES).toBe(16_384);
  });

  it("accepts a minimal answer and a 20-part / 8-citation maximum", () => {
    expect(parseStructuredAnswer(answer([{ text: "hi" }]))).toEqual(
      answer([{ text: "hi" }]),
    );
    const max = answer(
      Array.from({ length: 20 }, (_, i) => ({
        text: `part ${i}`,
        citations: Array.from({ length: 8 }, (_, j) => `r${j + 1}`),
      })),
    );
    expect(StructuredAnswerSchema.parse(max)).toEqual(max);
    expect(AnswerSubmitToolInputSchema.parse(max)).toEqual(max);
    expect(STRUCTURED_ANSWER_REGISTRY[1]).toBe(StructuredAnswerSchema);
  });

  it("rejects 0 parts and 21 parts", () => {
    expect(() =>
      StructuredAnswerSchema.parse({ version: 1, parts: [] }),
    ).toThrow();
    expect(() =>
      StructuredAnswerSchema.parse({
        version: 1,
        parts: Array.from({ length: 21 }, () => part("x")),
      }),
    ).toThrow();
  });

  it("rejects empty text and text over 4000 code points (astral-aware)", () => {
    expect(() => StructuredAnswerPartSchema.parse(part(""))).toThrow();
    const ok = "😀".repeat(4000);
    expect(StructuredAnswerPartSchema.parse(part(ok)).text).toBe(ok);
    expect(() =>
      StructuredAnswerPartSchema.parse(part("😀".repeat(4001))),
    ).toThrow();
    expect(() =>
      StructuredAnswerPartSchema.parse(part("x".repeat(4001))),
    ).toThrow();
    // Code points, not UTF-16 units: 4000 emoji are 8000 UTF-16 units.
    expect(ok.length).toBe(8000);
  });

  it("rejects 9 citations per part", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `r${i + 1}`);
    expect(() => StructuredAnswerPartSchema.parse(part("x", nine))).toThrow();
    expect(
      StructuredAnswerPartSchema.parse(
        part(
          "x",
          Array.from({ length: 8 }, (_, i) => `r${i + 1}`),
        ),
      ).citations,
    ).toHaveLength(8);
  });

  it("rejects wrong versions and unknown keys (strict, no truncation)", () => {
    expect(() =>
      parseStructuredAnswer({ version: 2, parts: [part("x")] }),
    ).toThrow();
    expect(() => parseStructuredAnswer({ parts: [part("x")] })).toThrow();
    expect(() =>
      StructuredAnswerSchema.parse({
        version: 1,
        parts: [part("x")],
        extra: 1,
      }),
    ).toThrow();
    expect(() =>
      StructuredAnswerPartSchema.parse({ text: "x", citations: [], extra: 1 }),
    ).toThrow();
    // Oversize input throws rather than truncating: parsed output equals input.
    const fitting = answer([{ text: "exact" }]);
    expect(StructuredAnswerSchema.parse(fitting)).toEqual(fitting);
  });
});

describe("citations are structural rN identifiers only (grant checks are kernel)", () => {
  it("accepts canonical rN ids", () => {
    for (const id of ["r1", "r2", "r12", "r9999999999"]) {
      expect(CitationIdSchema.parse(id)).toBe(id);
      expect(CITATION_ID_REGEX.test(id)).toBe(true);
    }
  });

  it("rejects non-canonical shapes", () => {
    for (const bad of [
      "",
      "r",
      "r0",
      "r01",
      "R1",
      "1",
      "r-1",
      " r1",
      "r1 ",
      "ref-1",
      "reference",
      UUID,
      "notes/a.md",
      "r1,r2",
    ]) {
      expect(CITATION_ID_REGEX.test(bad)).toBe(false);
      expect(() => CitationIdSchema.parse(bad)).toThrow();
    }
  });

  it("rejects non-string and overlong citations inside parts", () => {
    expect(() =>
      StructuredAnswerPartSchema.parse({ text: "x", citations: [42] }),
    ).toThrow();
    expect(() =>
      StructuredAnswerPartSchema.parse({ text: "x", citations: ["r1", "r0"] }),
    ).toThrow();
  });
});

describe("StructuredAnswer 16KiB whole-answer boundary (no truncation)", () => {
  it("measures canonical JSON UTF-8 bytes and agrees with Buffer", () => {
    const a = answer([{ text: "héllo 😀", citations: ["r1"] }]);
    const serialized = JSON.stringify(a);
    expect(measureStructuredAnswerBytes(a)).toBe(utf8ByteLength(serialized));
    expect(measureStructuredAnswerBytes(a)).toBe(
      Buffer.byteLength(serialized, "utf8"),
    );
    expect(MAX_STRUCTURED_ANSWER_BYTES).toBe(16 * 1024);
  });

  it("accepts exactly 16384 bytes and rejects 16385", () => {
    // One part caps at 4000 chars, so the boundary needs several parts.
    // ASCII keeps bytes == chars; solve the final part length exactly.
    const full = "a".repeat(4000);
    const probe = answer([
      { text: full },
      { text: full },
      { text: full },
      { text: full },
      { text: "b" },
    ]);
    const overhead = measureStructuredAnswerBytes(probe) - (4 * 4000 + 1);
    const lastLen = MAX_STRUCTURED_ANSWER_BYTES - overhead - 4 * 4000;
    expect(lastLen).toBeGreaterThanOrEqual(1);
    expect(lastLen).toBeLessThanOrEqual(4000);
    const atLimit = answer([
      { text: full },
      { text: full },
      { text: full },
      { text: full },
      { text: "b".repeat(lastLen) },
    ]);
    expect(measureStructuredAnswerBytes(atLimit)).toBe(
      MAX_STRUCTURED_ANSWER_BYTES,
    );
    expect(StructuredAnswerSchema.parse(atLimit)).toEqual(atLimit);
    const over = answer([
      { text: full },
      { text: full },
      { text: full },
      { text: full },
      { text: `b${"b".repeat(lastLen)}` },
    ]);
    expect(measureStructuredAnswerBytes(over)).toBe(
      MAX_STRUCTURED_ANSWER_BYTES + 1,
    );
    expect(() => StructuredAnswerSchema.parse(over)).toThrow();
    expect(() => parseStructuredAnswer(over)).toThrow();
  });

  it("counts multibyte characters as UTF-8 bytes toward the cap", () => {
    // 4000 emoji satisfy the per-part code-point bound (counted once each)
    // yet cost 16000 bytes; one such part still fits, two exceed the cap.
    const oneEmojiPart = answer([{ text: "😀".repeat(4000) }]);
    expect(measureStructuredAnswerBytes(oneEmojiPart)).toBeGreaterThan(16_000);
    expect(StructuredAnswerSchema.parse(oneEmojiPart)).toEqual(oneEmojiPart);
    const twoEmojiParts = answer([
      { text: "😀".repeat(4000) },
      { text: "😀".repeat(4000) },
    ]);
    expect(measureStructuredAnswerBytes(twoEmojiParts)).toBeGreaterThan(
      MAX_STRUCTURED_ANSWER_BYTES,
    );
    expect(() => StructuredAnswerSchema.parse(twoEmojiParts)).toThrow();
  });

  it("rejects many valid parts whose total exceeds 16KiB", () => {
    // Each part alone is valid (1000 chars, no citations) but 20 collide.
    const many = answer(
      Array.from({ length: 20 }, () => ({ text: "a".repeat(1000) })),
    );
    expect(measureStructuredAnswerBytes(many)).toBeGreaterThan(
      MAX_STRUCTURED_ANSWER_BYTES,
    );
    expect(() => StructuredAnswerSchema.parse(many)).toThrow();
  });
});

describe("reserved answer.submit protocol name", () => {
  it("fixes the reserved name and namespace", () => {
    expect(ANSWER_SUBMIT_TOOL_NAME).toBe("answer.submit");
    expect(RESERVED_ANSWER_NAMESPACE).toBe("answer");
    expect(AnswerSubmitToolInputSchema).toBe(StructuredAnswerSchema);
  });
});

describe("fixed M2 model/answer error vocabulary", () => {
  it("closes the M2 vocabulary to exactly four codes", () => {
    expect([...M2_MODEL_ERROR_CODES].sort()).toEqual(
      [
        "answer_invalid",
        "citation_invalid",
        "model_step_timeout",
        "model_unavailable",
      ].sort(),
    );
    expect(M2_MODEL_ERROR_CODES).toHaveLength(4);
    expect(KNOWN_M2_MODEL_ERROR_CODES).toBe(M2_MODEL_ERROR_CODES);
    for (const code of M2_MODEL_ERROR_CODES) {
      expect(M2ModelErrorCodeSchema.parse(code)).toBe(code);
      expect(parseM2ModelErrorCode(code)).toBe(code);
    }
    expect(M2_MODEL_ERROR_CODE_REGISTRY[1]).toBe(M2ModelErrorCodeSchema);
  });

  it("rejects free text, uppercase, and other families' codes", () => {
    for (const bad of [
      "made_up_code",
      "ModelUnavailable",
      "MODEL_STEP_TIMEOUT",
      "model unavailable",
      "execution_failed",
      "output_invalid",
      "budget_exceeded",
      "unknown_tool",
      "reference_not_found",
      "markdown_read_failed",
      "",
    ]) {
      expect(() => M2ModelErrorCodeSchema.parse(bad)).toThrow();
      expect(() => parseM2ModelErrorCode(bad)).toThrow();
    }
    // M2 codes are not valid Run codes, tool codes, or API codes.
    for (const code of M2_MODEL_ERROR_CODES) {
      expect(() => RunErrorCodeSchema.parse(code)).toThrow();
      expect(() => ToolErrorCodeSchema.parse(code)).toThrow();
      expect(() => ApiErrorCodeSchema.parse(code)).toThrow();
    }
    // And no M0/M1 code leaks into the M2 family.
    for (const code of [
      ...M0_RUN_ERROR_CODES,
      ...M0_TOOL_ERROR_CODES,
      ...M1_TOOL_ERROR_CODES,
    ]) {
      expect(() => M2ModelErrorCodeSchema.parse(code)).toThrow();
    }
  });
});

describe("model.step payloads are structural metadata only", () => {
  it("fixes the step budget at 8", () => {
    expect(MAX_MODEL_STEPS_PER_RUN).toBe(8);
  });

  it("started carries the step ordinal only", () => {
    expect(ModelStepStartedPayloadSchema.parse({ step: 1 })).toEqual({
      step: 1,
    });
    expect(ModelStepStartedPayloadSchema.parse({ step: 8 }).step).toBe(8);
    for (const bad of [0, -1, 9, 100, 1.5, "1", null]) {
      expect(() =>
        ModelStepStartedPayloadSchema.parse({ step: bad }),
      ).toThrow();
    }
  });

  it("completed carries step + timing + optional token usage", () => {
    expect(
      ModelStepCompletedPayloadSchema.parse({ step: 2, durationMs: 1500 }),
    ).toEqual({ step: 2, durationMs: 1500 });
    expect(
      ModelStepCompletedPayloadSchema.parse({
        step: 2,
        durationMs: 0,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ).toEqual({
      step: 2,
      durationMs: 0,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(() => ModelStepCompletedPayloadSchema.parse({ step: 1 })).toThrow();
    expect(() =>
      ModelStepCompletedPayloadSchema.parse({ step: 1, durationMs: -1 }),
    ).toThrow();
    expect(() =>
      ModelStepCompletedPayloadSchema.parse({
        step: 1,
        durationMs: 5,
        usage: { inputTokens: -1, outputTokens: 0 },
      }),
    ).toThrow();
    expect(() =>
      ModelStepUsageSchema.parse({ inputTokens: 1, outputTokens: 2, extra: 1 }),
    ).toThrow();
  });

  it("failed carries step + fixed code with optional timing", () => {
    expect(
      ModelStepFailedPayloadSchema.parse({
        step: 3,
        errorCode: "model_step_timeout",
      }),
    ).toEqual({ step: 3, errorCode: "model_step_timeout" });
    expect(
      ModelStepFailedPayloadSchema.parse({
        step: 1,
        errorCode: "citation_invalid",
        durationMs: 42,
      }).errorCode,
    ).toBe("citation_invalid");
    expect(() =>
      ModelStepFailedPayloadSchema.parse({
        step: 1,
        errorCode: "made_up_code",
      }),
    ).toThrow();
    expect(() => ModelStepFailedPayloadSchema.parse({ step: 1 })).toThrow();
  });

  it("rejects sensitive/raw content keys in every model payload", () => {
    const banned = [
      "prompt",
      "output",
      "rawOutput",
      "reasoning",
      "text",
      "content",
      "body",
      "snippet",
      "title",
      "path",
      "secret",
      "apiKey",
      "result",
    ];
    for (const key of banned) {
      expect(() =>
        ModelStepStartedPayloadSchema.parse({ step: 1, [key]: "leak" }),
      ).toThrow();
      expect(() =>
        ModelStepCompletedPayloadSchema.parse({
          step: 1,
          durationMs: 1,
          [key]: "leak",
        }),
      ).toThrow();
      expect(() =>
        ModelStepFailedPayloadSchema.parse({
          step: 1,
          errorCode: "model_unavailable",
          [key]: "leak",
        }),
      ).toThrow();
    }
  });
});

describe("M2/latest event registry (model.step.* non-terminal)", () => {
  it("fixes exactly the three M2 step types", () => {
    expect([...M2_MODEL_STEP_EVENT_TYPES].sort()).toEqual(
      [
        "model.step.completed",
        "model.step.failed",
        "model.step.started",
      ].sort(),
    );
    for (const type of M2_MODEL_STEP_EVENT_TYPES) {
      expect(M2ModelStepEventTypeSchema.parse(type)).toBe(type);
    }
    expect(() => M2ModelStepEventTypeSchema.parse("model.step")).toThrow();
    expect(() =>
      M2ModelStepEventTypeSchema.parse("model.step.delta"),
    ).toThrow();
  });

  it("M2 is M1 ten + three steps (13, closed); M0/M1 stay exact", () => {
    expect(M0_RUN_EVENT_TYPES).toHaveLength(9);
    expect(M1_RUN_EVENT_TYPES).toHaveLength(10);
    expect(M2_RUN_EVENT_TYPES).toHaveLength(13);
    expect([...M2_RUN_EVENT_TYPES].sort()).toEqual(
      [...M1_RUN_EVENT_TYPES, ...M2_MODEL_STEP_EVENT_TYPES].sort(),
    );
    expect(LATEST_RUN_EVENT_TYPES).toBe(M2_RUN_EVENT_TYPES);
    expect(Object.keys(M1_RUN_EVENT_PAYLOAD_SCHEMAS)).toHaveLength(10);
    expect(Object.keys(M2_RUN_EVENT_PAYLOAD_SCHEMAS)).toHaveLength(13);
    expect(LATEST_RUN_EVENT_PAYLOAD_SCHEMAS).toBe(M2_RUN_EVENT_PAYLOAD_SCHEMAS);
  });

  it("latest/M2 parsers understand all three steps with exact payloads", () => {
    const cases: Array<[string, unknown]> = [
      ["model.step.started", { step: 1 }],
      [
        "model.step.completed",
        {
          step: 1,
          durationMs: 250,
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      ],
      ["model.step.failed", { step: 2, errorCode: "model_unavailable" }],
    ];
    for (const [type, payload] of cases) {
      expect(parseRunEvent(envelope(type, payload)).type).toBe(type);
      expect(parseM2RunEvent(envelope(type, payload)).type).toBe(type);
      expect(M2RunEventSchema.parse(envelope(type, payload)).type).toBe(type);
      expect(LatestRunEventSchema.parse(envelope(type, payload)).type).toBe(
        type,
      );
      expect(parseRunEventPayload(type as never, payload)).toEqual(payload);
      expect(parseM2RunEventPayload(type as never, payload)).toEqual(payload);
    }
  });

  it("exact M0 and M1 registries reject model.step.*", () => {
    const payloads: Record<string, unknown> = {
      "model.step.started": { step: 1 },
      "model.step.completed": { step: 1, durationMs: 1 },
      "model.step.failed": { step: 1, errorCode: "model_unavailable" },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      expect(() => M0RunEventSchema.parse(envelope(type, payload))).toThrow();
      expect(() => M1RunEventSchema.parse(envelope(type, payload))).toThrow();
      expect(() => parseM0RunEvent(envelope(type, payload))).toThrow();
      expect(() => parseM1RunEvent(envelope(type, payload))).toThrow();
      expect(() =>
        parseM1RunEventPayload(type as "run.queued", payload),
      ).toThrow();
      expect(() =>
        M1EventsResponseSchema.parse({
          events: [envelope(type, payload)],
          nextAfter: 1,
          hasMore: false,
          terminal: false,
        }),
      ).toThrow();
      // Exact M0 HTTP page rejects them too.
      expect(() =>
        M0EventsResponseSchema.parse({
          events: [envelope(type, payload)],
          nextAfter: 1,
          hasMore: false,
          terminal: false,
        }),
      ).toThrow();
      // Generic/latest HTTP page accepts them (aligns with getEvents).
      expect(
        EventsResponseSchema.parse({
          events: [envelope(type, payload)],
          nextAfter: 1,
          hasMore: false,
          terminal: false,
        }).events,
      ).toHaveLength(1);
    }
  });

  it("model.step events are non-terminal and carry no RunResult", () => {
    for (const type of M2_MODEL_STEP_EVENT_TYPES) {
      expect(isTerminalEventType(type)).toBe(false);
      expect((TERMINAL_EVENT_TYPES as readonly string[]).includes(type)).toBe(
        false,
      );
    }
    expect([...TERMINAL_EVENT_TYPES].sort()).toEqual(
      ["run.abandoned", "run.cancelled", "run.completed", "run.failed"].sort(),
    );
    // A result smuggled into a model payload is rejected (strict).
    expect(() =>
      parseRunEvent(
        envelope("model.step.completed", {
          step: 1,
          durationMs: 1,
          result: { version: 1, text: "done" },
        }),
      ),
    ).toThrow();
    // Only run.completed carries a RunResult.
    expect(() =>
      parseRunEvent(
        envelope("model.step.started", {
          step: 1,
          result: { version: 1, text: "done" },
        }),
      ),
    ).toThrow();
  });

  it("latest/M2 still reject unknown and streaming-style names", () => {
    for (const type of [
      "model.step",
      "model.step.delta",
      "assistant.delta",
      "answer.committed",
      "citation.committed",
      "model.completed",
    ]) {
      expect(() => parseRunEvent(envelope(type, {}))).toThrow();
      expect(() => parseM2RunEvent(envelope(type, {}))).toThrow();
    }
  });

  it("envelopes stay strict (version/seq/keys) for model steps", () => {
    const good = envelope("model.step.started", { step: 1 });
    expect(() => parseRunEvent({ ...good, schemaVersion: 2 })).toThrow();
    expect(() => parseRunEvent({ ...good, seq: 0 })).toThrow();
    expect(() => M2RunEventSchema.parse({ ...good, surprise: true })).toThrow();
    expect(() =>
      parseRunEvent(envelope("model.step.started", { step: 1, text: "x" })),
    ).toThrow();
  });

  it("latest/M2 pages carry model.step events", () => {
    const page = LatestEventsResponseSchema.parse({
      events: [envelope("model.step.started", { step: 1 })],
      nextAfter: 1,
      hasMore: false,
      terminal: false,
    });
    expect(page.events).toHaveLength(1);
    expect(
      M2EventsResponseSchema.parse({
        events: [
          envelope("model.step.failed", {
            step: 1,
            errorCode: "answer_invalid",
          }),
        ],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
      }).events,
    ).toHaveLength(1);
    expect(() =>
      LatestEventsResponseSchema.parse({
        events: [envelope("model.step.started", { step: 1 })],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
        extra: 1,
      }),
    ).toThrow();
  });

  it("generic/latest HTTP page matches LatestRunEvent (V2 + steps, closed)", () => {
    const durable = {
      version: 2,
      text: "first\n\nsecond",
      answer: {
        version: 1,
        parts: [
          { text: "first", citations: [] },
          { text: "second", citations: ["r1"] },
        ],
      },
    };
    const page = EventsResponseSchema.parse({
      events: [
        envelope("model.step.started", { step: 1 }),
        envelope("run.completed", { result: durable }),
      ],
      nextAfter: 2,
      hasMore: false,
      terminal: true,
    });
    expect(page.events).toHaveLength(2);
    // Unknown future names are still rejected by the closed latest registry.
    expect(() =>
      EventsResponseSchema.parse({
        events: [envelope("model.step.delta", {})],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
      }),
    ).toThrow();
    // No raw model content leaks through the accepted step payload.
    expect(() =>
      EventsResponseSchema.parse({
        events: [
          envelope("model.step.completed", {
            step: 1,
            durationMs: 1,
            text: "leaked output",
          }),
        ],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
      }),
    ).toThrow();
  });
});

describe("M0/M1 behavior is preserved under the M2 latest", () => {
  it("M0 RunResult shape is untouched by StructuredAnswer", () => {
    expect(RunResultSchema.parse({ version: 1, text: "done" })).toEqual({
      version: 1,
      text: "done",
    });
    expect(() =>
      RunResultSchema.parse({ version: 1, parts: [{ text: "x" }] }),
    ).toThrow();
    expect(() =>
      StructuredAnswerSchema.parse({ version: 1, text: "done" }),
    ).toThrow();
  });

  it("all nine M0 types still parse via latest and exact M0", () => {
    const queued = envelope("run.queued", { attempt: 1 });
    expect(parseRunEvent(queued).type).toBe("run.queued");
    expect(parseM0RunEvent(queued).type).toBe("run.queued");
    expect(parseM1RunEvent(queued).type).toBe("run.queued");
  });
});
