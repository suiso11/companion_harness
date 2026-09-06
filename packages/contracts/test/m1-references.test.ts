import { describe, expect, it } from "vitest";
import {
  ApiErrorCodeSchema,
  CanonicalKeySchema,
  CanonicalResourceDetailSchema,
  CanonicalResourceSummarySchema,
  countCodePoints,
  DEFAULT_SEARCH_LIMIT,
  FreshnessSchema,
  FrozenContextSchema,
  LATEST_RUN_EVENT_PAYLOAD_SCHEMAS,
  LATEST_RUN_EVENT_TYPES,
  LATEST_TOOL_ERROR_CODES,
  LatestEventsResponseSchema,
  LatestRunEventSchema,
  LatestToolErrorCodeSchema,
  M0_RUN_EVENT_TYPES,
  M0_TOOL_ERROR_CODES,
  M0RunEventSchema,
  M0ToolCompletedPayloadSchema,
  M0ToolErrorCodeSchema,
  M0ToolResultSchema,
  M1_REFERENCE_ERROR_CODES,
  M1_RUN_EVENT_PAYLOAD_SCHEMAS,
  M1_RUN_EVENT_TYPES,
  M1_TOOL_ERROR_CODES,
  M1_TOOL_NAMES,
  M1ToolErrorCodeNewSchema,
  M1ToolErrorCodeSchema,
  M1ToolNameSchema,
  MAX_SEARCH_LIMIT,
  MAX_SNAPSHOT_BODY_BYTES,
  MAX_SNIPPET_CODE_POINTS,
  MAX_VAULT_FILES,
  MarkdownSearchHitSchema,
  MarkdownSearchSkippedEntrySchema,
  MarkdownSearchSkippedReasonSchema,
  MarkdownSearchToolInputSchema,
  MarkdownSearchToolOutputSchema,
  parseLatestToolErrorCode,
  parseM0RunEvent,
  parseM0RunEventPayload,
  parseM0ToolErrorCode,
  parseRunEvent,
  parseRunEventPayload,
  parseToolErrorCode,
  REFERENCE_PRESENTED_EVENT_TYPE,
  ReferenceContextGetResponseSchema,
  ReferenceContextPutRequestSchema,
  ReferenceContextPutResponseSchema,
  ReferenceContextSnapshotSchema,
  ReferenceDetailResponseSchema,
  ReferenceErrorCodeSchema,
  ReferenceListResponseSchema,
  ReferenceOpenToolInputSchema,
  ReferenceOpenToolOutputSchema,
  ReferenceParamsSchema,
  ReferencePresentedPayloadSchema,
  ReferenceRefreshToolInputSchema,
  ReferenceRefreshToolOutputSchema,
  ReferenceRelatedToolInputSchema,
  ReferenceRelatedToolOutputSchema,
  ReferenceSetDetailResponseSchema,
  ReferenceSetDetailSchema,
  ReferenceSetParamsSchema,
  ResourceSnapshotDetailSchema,
  ResourceSnapshotSummarySchema,
  RUN_EVENT_PAYLOAD_SCHEMAS,
  RunEventSchema,
  SearchQuerySchema,
  SessionReferenceDetailSchema,
  SessionReferenceSummarySchema,
  SNAPSHOT_BODY_VERSION,
  SnapshotBodySchema,
  SnippetSchema,
  StoredReferenceViewSchema,
  ToolCompletedPayloadSchema,
  ToolErrorCodeSchema,
  ToolResultSchema,
  utf8ByteLength,
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "223e4567-e89b-42d3-a456-426614174001";
const UUID3 = "323e4567-e89b-42d3-a456-426614174002";
const UUID4 = "423e4567-e89b-42d3-a456-426614174003";
const UUID5 = "523e4567-e89b-42d3-a456-426614174004";

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

function presentedPayload() {
  return {
    setId: UUID2,
    referenceId: UUID,
    ordinal: 1,
    snapshotId: UUID3,
    resourceId: UUID4,
  };
}

describe("M0 registry stays exact (9 types, no reference.presented)", () => {
  it("keeps the exact M0 nine", () => {
    expect(M0_RUN_EVENT_TYPES).toHaveLength(9);
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
    expect(Object.keys(RUN_EVENT_PAYLOAD_SCHEMAS)).toHaveLength(9);
    expect(
      Object.keys(RUN_EVENT_PAYLOAD_SCHEMAS).includes(
        REFERENCE_PRESENTED_EVENT_TYPE,
      ),
    ).toBe(false);
  });

  it("exact M0 schema rejects reference.presented and M2+ names", () => {
    expect(() =>
      M0RunEventSchema.parse(envelope("reference.presented", {})),
    ).toThrow();
    expect(() =>
      M0RunEventSchema.parse(
        envelope(REFERENCE_PRESENTED_EVENT_TYPE, presentedPayload()),
      ),
    ).toThrow();
    expect(() =>
      parseM0RunEvent(envelope("reference.presented", {})),
    ).toThrow();
    for (const type of [
      "citation.committed",
      "answer.committed",
      "model.step",
    ]) {
      expect(() => M0RunEventSchema.parse(envelope(type, {}))).toThrow();
    }
  });

  it("M0 payload parser rejects reference.presented as unknown", () => {
    expect(() =>
      parseM0RunEventPayload(
        REFERENCE_PRESENTED_EVENT_TYPE as "run.queued",
        presentedPayload(),
      ),
    ).toThrow();
  });

  it("M0 envelope alias still parses all nine M0 types", () => {
    expect(
      M0RunEventSchema.parse(envelope("run.queued", { attempt: 1 })).type,
    ).toBe("run.queued");
    expect(RunEventSchema).toBe(M0RunEventSchema);
  });
});

describe("latest registry extends with nonterminal reference.presented", () => {
  it("latest is M0 nine + reference.presented (10, closed)", () => {
    expect(REFERENCE_PRESENTED_EVENT_TYPE).toBe("reference.presented");
    expect(M1_RUN_EVENT_TYPES).toHaveLength(10);
    expect(LATEST_RUN_EVENT_TYPES).toEqual(M1_RUN_EVENT_TYPES);
    expect([...M1_RUN_EVENT_TYPES].sort()).toEqual(
      [...M0_RUN_EVENT_TYPES, "reference.presented"].sort(),
    );
    expect(Object.keys(M1_RUN_EVENT_PAYLOAD_SCHEMAS)).toHaveLength(10);
    expect(Object.keys(LATEST_RUN_EVENT_PAYLOAD_SCHEMAS)).toHaveLength(10);
  });

  it("generic/latest parsers understand reference.presented", () => {
    const event = parseRunEvent(
      envelope("reference.presented", presentedPayload()),
    );
    expect(event.type).toBe("reference.presented");
    expect(LatestRunEventSchema.parse(event)).toEqual(event);
    expect(
      parseRunEventPayload("reference.presented", presentedPayload()),
    ).toEqual(presentedPayload());
  });

  it("reference.presented is nonterminal and carries no terminal result", () => {
    const event = parseRunEvent(
      envelope("reference.presented", presentedPayload()),
    );
    expect(event.type).not.toBe("run.completed");
    expect("result" in event.payload).toBe(false);
  });

  it("payload is structural IDs/ordinals only (no content keys)", () => {
    const parsed = ReferencePresentedPayloadSchema.parse(presentedPayload());
    expect(Object.keys(parsed).sort()).toEqual(
      ["ordinal", "referenceId", "resourceId", "setId", "snapshotId"].sort(),
    );
    for (const banned of [
      "body",
      "body_json",
      "snippet",
      "title",
      "content",
      "path",
      "text",
    ]) {
      expect(() =>
        ReferencePresentedPayloadSchema.parse({
          ...presentedPayload(),
          [banned]: "leak",
        }),
      ).toThrow();
    }
    expect(() =>
      ReferencePresentedPayloadSchema.parse({
        ...presentedPayload(),
        ordinal: 0,
      }),
    ).toThrow();
    expect(() =>
      ReferencePresentedPayloadSchema.parse({
        ...presentedPayload(),
        referenceId: "r1",
      }),
    ).toThrow();
  });

  it("latest still rejects M2+ names and content-less terminal rules hold", () => {
    for (const type of [
      "citation.committed",
      "answer.committed",
      "model.step",
    ]) {
      expect(() => parseRunEvent(envelope(type, {}))).toThrow();
    }
    expect(() => parseRunEvent(envelope("run.completed", {}))).toThrow();
  });

  it("latest events page carries reference.presented; M0 page shape intact", () => {
    const page = LatestEventsResponseSchema.parse({
      events: [envelope("reference.presented", presentedPayload())],
      nextAfter: 1,
      hasMore: false,
      terminal: false,
    });
    expect(page.events).toHaveLength(1);
    expect(() =>
      LatestEventsResponseSchema.parse({
        events: [envelope("reference.presented", presentedPayload())],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("code-point bounds (query 1-256, limit default10/max20, snippet 512)", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(countCodePoints("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(countCodePoints("a😀b")).toBe(3);
  });

  it("accepts exactly 256 code points incl. astral chars, rejects 257", () => {
    const ok = "😀".repeat(256);
    expect(countCodePoints(ok)).toBe(256);
    expect(SearchQuerySchema.parse(ok)).toBe(ok);
    expect("x".repeat(256)).toHaveLength(256);
    expect(() => SearchQuerySchema.parse("😀".repeat(257))).toThrow();
    expect(() => SearchQuerySchema.parse("x".repeat(257))).toThrow();
    expect(() => SearchQuerySchema.parse("")).toThrow();
    expect(() => SearchQuerySchema.parse(42 as unknown as string)).toThrow();
  });

  it("search limit defaults to 10 and caps at 20", () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(10);
    expect(MAX_SEARCH_LIMIT).toBe(20);
    expect(MarkdownSearchToolInputSchema.parse({ query: "hi" }).limit).toBe(10);
    expect(
      MarkdownSearchToolInputSchema.parse({ query: "hi", limit: 20 }).limit,
    ).toBe(20);
    expect(() =>
      MarkdownSearchToolInputSchema.parse({ query: "hi", limit: 0 }),
    ).toThrow();
    expect(() =>
      MarkdownSearchToolInputSchema.parse({ query: "hi", limit: 21 }),
    ).toThrow();
    expect(
      ReferenceRelatedToolInputSchema.parse({ referenceId: UUID }).limit,
    ).toBe(10);
  });

  it("snippets cap at 512 code points (astral-aware)", () => {
    const ok = "😀".repeat(512);
    expect(SnippetSchema.parse(ok)).toBe(ok);
    expect(MAX_SNIPPET_CODE_POINTS).toBe(512);
    expect(() => SnippetSchema.parse("😀".repeat(513))).toThrow();
    expect(() => SnippetSchema.parse("y".repeat(513))).toThrow();
    expect(() => SnippetSchema.parse("")).toThrow();
  });

  it("search/related outputs cap collections at max20", () => {
    const hit = {
      referenceId: UUID,
      ordinal: 1,
      snapshotId: UUID3,
      resourceId: UUID4,
      canonicalKey: "notes/a.md",
      title: "A",
      snippet: "hit",
    };
    expect(MarkdownSearchHitSchema.parse(hit)).toEqual(hit);
    expect(
      MarkdownSearchToolOutputSchema.parse({
        hits: Array.from({ length: 20 }, () => hit),
        skipped: [],
      }).hits,
    ).toHaveLength(20);
    expect(() =>
      MarkdownSearchToolOutputSchema.parse({
        hits: Array.from({ length: 21 }, () => hit),
        skipped: [],
      }),
    ).toThrow();
    expect(() =>
      ReferenceRelatedToolOutputSchema.parse({
        references: Array.from({ length: 21 }, () => ({
          referenceId: UUID,
          ordinal: 1,
          snapshotId: UUID3,
          resourceId: UUID4,
          canonicalKey: "notes/a.md",
          title: null,
        })),
      }),
    ).toThrow();
  });

  it("freshness is exactly normal/refresh with normal default", () => {
    expect(FreshnessSchema.parse("normal")).toBe("normal");
    expect(FreshnessSchema.parse("refresh")).toBe("refresh");
    expect(MarkdownSearchToolInputSchema.parse({ query: "q" }).freshness).toBe(
      "normal",
    );
    expect(() => FreshnessSchema.parse("auto")).toThrow();
    expect(() => FreshnessSchema.parse("NORMAL")).toThrow();
  });
});

describe("summaries/details are strict with UUID v4 ids", () => {
  const resource = {
    id: UUID4,
    canonicalKey: "notes/a.md",
    title: "A",
  };
  const snapshot = {
    id: UUID3,
    resourceId: UUID4,
    revision: 2,
    sourceRevision: null,
    contentHash: "a".repeat(64),
    sizeBytes: 12,
    observedAt: 5,
  };

  it("resource summary/detail accept relative keys, reject absolute paths", () => {
    expect(CanonicalResourceSummarySchema.parse(resource)).toEqual(resource);
    expect(
      CanonicalResourceDetailSchema.parse({
        ...resource,
        connectorInstanceId: UUID5,
        nextRevision: 3,
        createdAt: 7,
      }).nextRevision,
    ).toBe(3);
    for (const bad of [
      "/abs/path.md",
      "C:/win/path.md",
      "a\\b.md",
      "../escape.md",
      "a//b.md",
      "",
    ]) {
      expect(() => CanonicalKeySchema.parse(bad)).toThrow();
    }
    expect(() =>
      CanonicalResourceSummarySchema.parse({ ...resource, path: "/abs" }),
    ).toThrow();
  });

  it("snapshot summary/detail enforce revision/hash/uuid strictness", () => {
    expect(ResourceSnapshotSummarySchema.parse(snapshot)).toEqual(snapshot);
    expect(
      ResourceSnapshotDetailSchema.parse({ ...snapshot, createdAt: 9 }),
    ).toMatchObject({ createdAt: 9 });
    expect(() =>
      ResourceSnapshotSummarySchema.parse({ ...snapshot, revision: 0 }),
    ).toThrow();
    expect(() =>
      ResourceSnapshotSummarySchema.parse({
        ...snapshot,
        contentHash: "zz",
      }),
    ).toThrow();
    expect(() =>
      ResourceSnapshotSummarySchema.parse({
        ...snapshot,
        body: "leak",
      }),
    ).toThrow();
  });

  it("session-reference summary/detail enforce ordinals and session ids", () => {
    expect(
      SessionReferenceSummarySchema.parse({
        id: UUID,
        ordinal: 3,
        resourceId: UUID4,
        snapshotId: UUID3,
      }).ordinal,
    ).toBe(3);
    expect(
      SessionReferenceDetailSchema.parse({
        sessionId: UUID5,
        id: UUID,
        ordinal: 1,
        resourceId: UUID4,
        snapshotId: UUID3,
        createdAt: 1,
      }).sessionId,
    ).toBe(UUID5);
    expect(() =>
      SessionReferenceSummarySchema.parse({
        id: UUID,
        ordinal: 0,
        resourceId: UUID4,
        snapshotId: UUID3,
      }),
    ).toThrow();
    expect(() =>
      SessionReferenceDetailSchema.parse({
        sessionId: "not-a-uuid",
        id: UUID,
        ordinal: 1,
        resourceId: UUID4,
        snapshotId: UUID3,
        createdAt: 1,
      }),
    ).toThrow();
  });

  it("reference-set detail keeps ordered items", () => {
    const set = {
      sessionId: UUID5,
      id: UUID2,
      createdAt: 4,
      items: [
        { ordinal: 1, referenceId: UUID },
        { ordinal: 2, referenceId: UUID3 },
      ],
    };
    expect(ReferenceSetDetailSchema.parse(set)).toEqual(set);
    expect(() =>
      ReferenceSetDetailSchema.parse({ ...set, items: "x" }),
    ).toThrow();
  });

  it("stored-only API responses reject unknown keys and bad ids", () => {
    const body = { version: 1 as const, text: "full normalized evidence" };
    expect(
      ReferenceListResponseSchema.parse({
        items: [{ id: UUID, ordinal: 1, resourceId: UUID4, snapshotId: UUID3 }],
      }).items,
    ).toHaveLength(1);
    expect(
      ReferenceDetailResponseSchema.parse({
        reference: {
          sessionId: UUID5,
          id: UUID,
          ordinal: 1,
          resourceId: UUID4,
          snapshotId: UUID3,
          createdAt: 1,
        },
        resource,
        snapshot,
        body,
      }).body,
    ).toEqual(body);
    expect(() =>
      ReferenceDetailResponseSchema.parse({
        reference: {
          sessionId: UUID5,
          id: UUID,
          ordinal: 1,
          resourceId: UUID4,
          snapshotId: UUID3,
          createdAt: 1,
        },
        resource,
        snapshot,
      }),
    ).toThrow();
    expect(
      ReferenceSetDetailResponseSchema.parse({
        set: {
          sessionId: UUID5,
          id: UUID2,
          createdAt: 4,
          items: [{ ordinal: 1, referenceId: UUID }],
        },
        references: [
          { id: UUID, ordinal: 1, resourceId: UUID4, snapshotId: UUID3 },
        ],
      }).references,
    ).toHaveLength(1);
    expect(() =>
      ReferenceParamsSchema.parse({ sessionId: UUID5, referenceId: "r1" }),
    ).toThrow();
    expect(() =>
      ReferenceSetParamsSchema.parse({ sessionId: UUID5, setId: "s1" }),
    ).toThrow();
    expect(() =>
      ReferenceListResponseSchema.parse({ items: [], cursor: 1 }),
    ).toThrow();
  });

  it("tool inputs/outputs are strict ToolBroker DTOs (no HTTP POST shape)", () => {
    expect(ReferenceOpenToolInputSchema.parse({ referenceId: UUID })).toEqual({
      referenceId: UUID,
    });
    expect(
      ReferenceRefreshToolInputSchema.parse({ referenceId: UUID }),
    ).toEqual({ referenceId: UUID });
    const view = {
      referenceId: UUID,
      ordinal: 1,
      snapshotId: UUID3,
      resourceId: UUID4,
      canonicalKey: "notes/a.md",
      title: null,
      snippet: "excerpt",
      body: { version: 1 as const, text: "full normalized evidence" },
    };
    expect(ReferenceOpenToolOutputSchema.parse(view)).toEqual(view);
    expect(ReferenceRefreshToolOutputSchema.parse(view)).toEqual(view);
    expect(StoredReferenceViewSchema.parse(view)).toEqual(view);
    expect(() =>
      ReferenceOpenToolOutputSchema.parse({
        referenceId: UUID,
        ordinal: 1,
        snapshotId: UUID3,
        resourceId: UUID4,
        canonicalKey: "notes/a.md",
        title: null,
        snippet: "excerpt",
      }),
    ).toThrow();
    expect(() =>
      MarkdownSearchHitSchema.parse({ ...view, body: view.body }),
    ).toThrow();
    expect(() =>
      MarkdownSearchToolInputSchema.parse({ query: "q", limit: 5, post: 1 }),
    ).toThrow();
    expect(() =>
      ReferenceOpenToolInputSchema.parse({ referenceId: UUID, extra: 1 }),
    ).toThrow();
  });
});

describe("reference context CAS DTOs + frozen snapshot compat", () => {
  it("GET/PUT DTOs carry { version, items } and reject unknown keys", () => {
    const ctx = { version: 2, items: [UUID, UUID3] };
    expect(ReferenceContextGetResponseSchema.parse(ctx)).toEqual(ctx);
    expect(ReferenceContextPutRequestSchema.parse(ctx)).toEqual(ctx);
    expect(ReferenceContextPutResponseSchema.parse(ctx)).toEqual(ctx);
    expect(() =>
      ReferenceContextPutRequestSchema.parse({ version: 0, items: [] }),
    ).toThrow();
    expect(() =>
      ReferenceContextPutRequestSchema.parse({
        version: 1,
        items: ["r1"],
      }),
    ).toThrow();
    expect(() =>
      ReferenceContextGetResponseSchema.parse({ ...ctx, sessionId: UUID5 }),
    ).toThrow();
  });

  it("stored M0 frozen turns still parse; M1 snapshot is optional/ordered", () => {
    const m0 = FrozenContextSchema.parse({
      version: 1,
      temporal: { now: 1, timeZone: "UTC" },
    });
    expect(m0.referenceContext).toBeUndefined();
    expect(m0.uiContext).toEqual({});
    const m1 = FrozenContextSchema.parse({
      version: 1,
      temporal: { now: 1, timeZone: "UTC" },
      referenceContext: { version: 3, items: [UUID, UUID3] },
    });
    expect(m1.referenceContext).toEqual({ version: 3, items: [UUID, UUID3] });
    expect(
      ReferenceContextSnapshotSchema.parse({ version: 1, items: [] }),
    ).toEqual({ version: 1, items: [] });
    expect(() =>
      FrozenContextSchema.parse({
        version: 1,
        temporal: { now: 1, timeZone: "UTC" },
        referenceContext: { version: 0, items: [] },
      }),
    ).toThrow();
    expect(() =>
      FrozenContextSchema.parse({
        version: 1,
        temporal: { now: 1, timeZone: "UTC" },
        referenceContext: { version: 1, items: [], extra: 1 },
      }),
    ).toThrow();
  });
});

describe("reference error codes are fixed lowercase; M0 API codes untouched", () => {
  it("closes the M1 reference vocabulary to exactly three codes", () => {
    expect([...M1_REFERENCE_ERROR_CODES].sort()).toEqual(
      [
        "invalid_reference",
        "reference_not_found",
        "reference_version_conflict",
      ].sort(),
    );
    for (const code of M1_REFERENCE_ERROR_CODES) {
      expect(ReferenceErrorCodeSchema.parse(code)).toBe(code);
    }
    for (const bad of [
      "ReferenceNotFound",
      "REFERENCE_CONFLICT",
      "reference conflict",
      "made_up_code",
      "",
    ]) {
      expect(() => ReferenceErrorCodeSchema.parse(bad)).toThrow();
    }
  });

  it("leaves the exact M0 API error set unchanged", () => {
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
    expect(() => ApiErrorCodeSchema.parse("reference_not_found")).toThrow();
    expect(() =>
      ApiErrorCodeSchema.parse("reference_version_conflict"),
    ).toThrow();
  });
});

describe("SnapshotBody is strict versioned full text (1MiB UTF-8, no truncation)", () => {
  it("fixes the implementation-level shape { version: 1, text }", () => {
    expect(SNAPSHOT_BODY_VERSION).toBe(1);
    expect(MAX_SNAPSHOT_BODY_BYTES).toBe(1_048_576);
    expect(SnapshotBodySchema.parse({ version: 1, text: "hello" })).toEqual({
      version: 1,
      text: "hello",
    });
    expect(SnapshotBodySchema.parse({ version: 1, text: "" }).text).toBe("");
    expect(() =>
      SnapshotBodySchema.parse({ version: 2, text: "hi" }),
    ).toThrow();
    expect(() =>
      SnapshotBodySchema.parse({ version: 1, text: "hi", extra: 1 }),
    ).toThrow();
  });

  it("counts UTF-8 bytes (not code points or UTF-16 units)", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("あ")).toBe(3);
  });

  it("rejects oversize bodies without truncation and non-NFC text", () => {
    const atLimit = "a".repeat(MAX_SNAPSHOT_BODY_BYTES);
    expect(utf8ByteLength(atLimit)).toBe(MAX_SNAPSHOT_BODY_BYTES);
    expect(SnapshotBodySchema.parse({ version: 1, text: atLimit }).text).toBe(
      atLimit,
    );
    expect(() =>
      SnapshotBodySchema.parse({
        version: 1,
        text: `a${"a".repeat(MAX_SNAPSHOT_BODY_BYTES)}`,
      }),
    ).toThrow();
    expect(() => SnapshotBodySchema.parse({ version: 1, text: "é" })).toThrow();
  });
});

describe("M1 tool names closed; no M2+ contracts", () => {
  it("fixes exactly the four M1 ToolBroker tools", () => {
    expect(M1_TOOL_NAMES).toHaveLength(4);
    expect([...M1_TOOL_NAMES].sort()).toEqual(
      [
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
      ].sort(),
    );
    for (const name of M1_TOOL_NAMES) {
      expect(M1ToolNameSchema.parse(name)).toBe(name);
    }
    expect(() => M1ToolNameSchema.parse("citation.submit")).toThrow();
    expect(() => M1ToolNameSchema.parse("agent.run")).toThrow();
  });

  it("exposes no citation/agent/model/UI contract names", () => {
    const forbidden = [
      "citation",
      "agent",
      "model",
      "evidence",
      "answer",
      "widget",
    ];
    const exported: string[] = [
      ...M1_TOOL_NAMES,
      ...M1_REFERENCE_ERROR_CODES,
      ...M1_RUN_EVENT_TYPES,
    ];
    for (const name of exported) {
      for (const word of forbidden) {
        expect(name.includes(word)).toBe(false);
      }
    }
    expect(M1_TOOL_NAMES.includes("citation.submit" as never)).toBe(false);
  });
});

describe("M1 tool error registry (connector/reference handlers)", () => {
  it("fixes exactly the five M1 additions; latest is M0 nine + M1 five (14, closed)", () => {
    expect([...M1_TOOL_ERROR_CODES].sort()).toEqual(
      [
        "markdown_path_unsafe",
        "markdown_read_changed",
        "markdown_read_failed",
        "markdown_vault_too_large",
        "reference_not_found",
      ].sort(),
    );
    expect(M1_TOOL_ERROR_CODES).toHaveLength(5);
    expect(M0_TOOL_ERROR_CODES).toHaveLength(9);
    expect(LATEST_TOOL_ERROR_CODES).toHaveLength(14);
    expect([...LATEST_TOOL_ERROR_CODES].sort()).toEqual(
      [...M0_TOOL_ERROR_CODES, ...M1_TOOL_ERROR_CODES].sort(),
    );
    for (const code of M1_TOOL_ERROR_CODES) {
      expect(M1ToolErrorCodeNewSchema.parse(code)).toBe(code);
      expect(M1ToolErrorCodeSchema.parse(code)).toBe(code);
      expect(LatestToolErrorCodeSchema.parse(code)).toBe(code);
      expect(ToolErrorCodeSchema.parse(code)).toBe(code);
      expect(parseToolErrorCode(code)).toBe(code);
      expect(parseLatestToolErrorCode(code)).toBe(code);
    }
    for (const code of M0_TOOL_ERROR_CODES) {
      expect(M1ToolErrorCodeSchema.parse(code)).toBe(code);
      expect(ToolErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("latest/generic is an explicit closed union (no regex, no free text, no M2+)", () => {
    for (const bad of [
      "made_up_code",
      "markdown_skipped",
      "file_too_large",
      "invalid_utf8",
      "markdown_too_large",
      "citation_failed",
      "agent_failed",
      "model_failed",
      "",
      "MARKDOWN_READ_FAILED",
      "markdown read failed",
    ]) {
      expect(() => M1ToolErrorCodeSchema.parse(bad)).toThrow();
      expect(() => ToolErrorCodeSchema.parse(bad)).toThrow();
      expect(() => parseToolErrorCode(bad)).toThrow();
    }
    // Per-file skip reasons are output reasons, never error codes.
    expect(() => ToolErrorCodeSchema.parse("file_too_large")).toThrow();
    expect(() => ToolErrorCodeSchema.parse("invalid_utf8")).toThrow();
  });

  it("exact M0 stays nine-only while latest tool.completed accepts M1", () => {
    const base = {
      callId: UUID,
      callIndex: 1,
      tool: "markdown.search",
      actualOutcome: "failed",
      reportedOutcome: "failed",
      disposition: "none",
      resultDigest: null,
      reusedFromCallId: null,
    };
    for (const code of M1_TOOL_ERROR_CODES) {
      expect(() =>
        M0ToolCompletedPayloadSchema.parse({ ...base, errorCode: code }),
      ).toThrow();
      expect(() => parseM0ToolErrorCode(code)).toThrow();
      expect(
        ToolCompletedPayloadSchema.parse({ ...base, errorCode: code })
          .errorCode,
      ).toBe(code);
      expect(
        ToolResultSchema.parse({
          tool: "markdown.search",
          callIndex: 1,
          actualOutcome: "failed",
          reportedOutcome: "failed",
          disposition: "none",
          errorCode: code,
          resultDigest: null,
          reusedFromCallId: null,
          finishedAt: 1,
        }).errorCode,
      ).toBe(code);
      expect(() =>
        M0ToolResultSchema.parse({
          tool: "markdown.search",
          callIndex: 1,
          actualOutcome: "failed",
          reportedOutcome: "failed",
          disposition: "none",
          errorCode: code,
          resultDigest: null,
          reusedFromCallId: null,
          finishedAt: 1,
        }),
      ).toThrow();
    }
    // M0 nine still validate on both paths.
    for (const code of M0_TOOL_ERROR_CODES) {
      expect(M0ToolErrorCodeSchema.parse(code)).toBe(code);
      expect(ToolErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("fixes the vault bound at exactly 10000 files", () => {
    expect(MAX_VAULT_FILES).toBe(10_000);
  });
});

describe("Markdown search skipped list (explicit, non-truncated, no absolute paths)", () => {
  const hit = {
    referenceId: UUID,
    ordinal: 1,
    snapshotId: UUID3,
    resourceId: UUID4,
    canonicalKey: "notes/a.md",
    title: "A",
    snippet: "hit",
  };

  it("requires an explicit skipped list alongside hits", () => {
    expect(
      MarkdownSearchToolOutputSchema.parse({ hits: [hit], skipped: [] }),
    ).toEqual({ hits: [hit], skipped: [] });
    // Missing skipped is rejected (explicit, never implicit).
    expect(() =>
      MarkdownSearchToolOutputSchema.parse({ hits: [hit] }),
    ).toThrow();
    // Unknown keys rejected (strict).
    expect(() =>
      MarkdownSearchToolOutputSchema.parse({
        hits: [hit],
        skipped: [],
        extra: 1,
      }),
    ).toThrow();
  });

  it("closes skip reasons to file_too_large/invalid_utf8 (never whole-call errors)", () => {
    expect(MarkdownSearchSkippedReasonSchema.parse("file_too_large")).toBe(
      "file_too_large",
    );
    expect(MarkdownSearchSkippedReasonSchema.parse("invalid_utf8")).toBe(
      "invalid_utf8",
    );
    for (const bad of [
      "markdown_vault_too_large",
      "markdown_path_unsafe",
      "markdown_read_failed",
      "markdown_read_changed",
      "reference_not_found",
      "truncated",
      "",
    ]) {
      expect(() => MarkdownSearchSkippedReasonSchema.parse(bad)).toThrow();
    }
    expect(
      MarkdownSearchSkippedEntrySchema.parse({
        canonicalKey: "notes/big.md",
        reason: "file_too_large",
      }),
    ).toEqual({ canonicalKey: "notes/big.md", reason: "file_too_large" });
    expect(() =>
      MarkdownSearchSkippedEntrySchema.parse({
        canonicalKey: "notes/big.md",
        reason: "file_too_large",
        extra: 1,
      }),
    ).toThrow();
  });

  it("skipped entries carry route-relative keys only (no absolute paths)", () => {
    for (const bad of [
      "/abs/path.md",
      "C:/win/path.md",
      "a\\b.md",
      "../escape.md",
      "a//b.md",
      "",
    ]) {
      expect(() =>
        MarkdownSearchSkippedEntrySchema.parse({
          canonicalKey: bad,
          reason: "file_too_large",
        }),
      ).toThrow();
    }
    expect(() =>
      MarkdownSearchToolOutputSchema.parse({
        hits: [],
        skipped: [{ canonicalKey: "/abs/path.md", reason: "invalid_utf8" }],
      }),
    ).toThrow();
  });

  it("skipped list is unbounded by item count (truncation forbidden)", () => {
    const skipped = Array.from({ length: 250 }, (_, i) => ({
      canonicalKey: `notes/file-${i}.md`,
      reason: "file_too_large" as const,
    }));
    expect(
      MarkdownSearchToolOutputSchema.parse({ hits: [], skipped }).skipped,
    ).toHaveLength(250);
    // Hits stay capped at max 20 while skipped is uncapped.
    expect(() =>
      MarkdownSearchToolOutputSchema.parse({
        hits: Array.from({ length: 21 }, () => hit),
        skipped: [],
      }),
    ).toThrow();
  });
});
