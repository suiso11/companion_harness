// Ollama `tool_name` vs OpenAI-compatible `tool_call_id` wire compatibility.
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { validateChatRequest } from "../src/gateway.js";
import { createOllamaGateway, toOllamaMessage } from "../src/ollama.js";
import {
  createOpenAICompatibleGateway,
  toOpenAIMessage,
} from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(response: Response): {
  fetchImpl: FetchImpl;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("role:tool tool_name wire compatibility", () => {
  it("ollama serializes role:tool with tool_name and no tool_call_id", () => {
    expect(
      toOllamaMessage({
        role: "tool",
        content: "feedback",
        toolCallId: "call_1",
        toolName: "notes.search",
      }),
    ).toEqual({
      role: "tool",
      content: "feedback",
      tool_name: "notes.search",
    });
  });

  it("openai-compatible serializes role:tool with tool_call_id and no tool_name", () => {
    expect(
      toOpenAIMessage({
        role: "tool",
        content: "feedback",
        toolCallId: "call_1",
        toolName: "notes.search",
      }),
    ).toEqual({
      role: "tool",
      content: "feedback",
      tool_call_id: "call_1",
    });
  });

  it("ollama request body carries exact tool messages without tool_call_id", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        message: { role: "assistant", content: "done" },
        done: true,
        done_reason: "stop",
      }),
    );
    await createOllamaGateway({
      baseUrl: "http://localhost:11434",
      fetchImpl,
    }).chat(
      baseRequest({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "c0", name: "notes.search", arguments: { q: "x" } },
              { id: "c1", name: "notes.open", arguments: {} },
            ],
          },
          {
            role: "tool",
            content: "first",
            toolCallId: "c0",
            toolName: "notes.search",
          },
          {
            role: "tool",
            content: "second",
            toolCallId: "c1",
            toolName: "notes.open",
          },
        ],
      }),
    );
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Record<string, unknown>[];
    };
    expect(sent.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c0",
            function: { name: "notes.search", arguments: { q: "x" } },
          },
          { id: "c1", function: { name: "notes.open", arguments: {} } },
        ],
      },
      { role: "tool", content: "first", tool_name: "notes.search" },
      { role: "tool", content: "second", tool_name: "notes.open" },
    ]);
    for (const message of sent.messages) {
      expect(message).not.toHaveProperty("tool_call_id");
      expect(message).not.toHaveProperty("toolCallId");
    }
  });

  it("openai request body carries exact tool messages without tool_name", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl,
    }).chat(
      baseRequest({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "c0", name: "notes.search", arguments: { q: "x" } },
              { id: "c1", name: "notes.open", arguments: {} },
            ],
          },
          {
            role: "tool",
            content: "first",
            toolCallId: "c0",
            toolName: "notes.search",
          },
          {
            role: "tool",
            content: "second",
            toolCallId: "c1",
            toolName: "notes.open",
          },
        ],
      }),
    );
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Record<string, unknown>[];
    };
    expect(sent.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c0",
            type: "function",
            function: {
              name: "notes.search",
              arguments: JSON.stringify({ q: "x" }),
            },
          },
          {
            id: "c1",
            type: "function",
            function: { name: "notes.open", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "first", tool_call_id: "c0" },
      { role: "tool", content: "second", tool_call_id: "c1" },
    ]);
    for (const message of sent.messages) {
      expect(message).not.toHaveProperty("tool_name");
      expect(message).not.toHaveProperty("toolName");
    }
  });

  it("rejects toolName on non-tool roles and invalid tool names", () => {
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [{ role: "user", content: "hi", toolName: "notes.search" }],
        }),
      ),
    ).toThrowError(ModelLocalError);
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [{ role: "tool", content: "hi", toolName: "" }],
        }),
      ),
    ).toThrowError(ModelLocalError);
  });
});

describe("role:tool correlation required (r3944753217)", () => {
  function expectInvalidRequest(fn: () => unknown, notLeak?: string): void {
    try {
      fn();
      expect.unreachable("should reject uncorrelated tool message");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      const err = error as ModelLocalError;
      expect(err.code).toBe("invalid_request");
      expect(err.message).not.toContain("secret");
      if (notLeak !== undefined) {
        expect(err.message).not.toContain(notLeak);
      }
    }
  }

  it("requires both toolCallId and toolName on every role:tool message", () => {
    // Fully correlated passes.
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "tool",
              content: "ok",
              toolCallId: "call_1",
              toolName: "notes.search",
            },
          ],
        }),
      ),
    ).not.toThrow();
    // Bare or half-correlated tool messages reject with fixed codes.
    expectInvalidRequest(() =>
      validateChatRequest(
        baseRequest({ messages: [{ role: "tool", content: "bare" }] }),
      ),
    );
    expectInvalidRequest(
      () =>
        validateChatRequest(
          baseRequest({
            messages: [
              { role: "tool", content: "no-name", toolCallId: "call_1" },
            ],
          }),
        ),
      "call_1",
    );
    expectInvalidRequest(
      () =>
        validateChatRequest(
          baseRequest({
            messages: [
              { role: "tool", content: "no-id", toolName: "notes.search" },
            ],
          }),
        ),
      "notes.search",
    );
    expectInvalidRequest(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "tool",
              content: "empty",
              toolCallId: "",
              toolName: "notes.search",
            },
          ],
        }),
      ),
    );
    expectInvalidRequest(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "tool",
              content: "empty",
              toolCallId: "call_1",
              toolName: "",
            },
          ],
        }),
      ),
    );
    expectInvalidRequest(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "tool",
              content: "over",
              toolCallId: "x".repeat(257),
              toolName: "notes.search",
            },
          ],
        }),
      ),
    );
    expectInvalidRequest(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "tool",
              content: "over",
              toolCallId: "call_1",
              toolName: "x".repeat(129),
            },
          ],
        }),
      ),
    );
  });

  it("rejects top-level tool correlation smuggled on non-tool roles", () => {
    for (const role of ["system", "user", "assistant"] as const) {
      expectInvalidRequest(
        () =>
          validateChatRequest(
            baseRequest({
              messages: [{ role, content: "hi", toolCallId: "call_1" }],
            }),
          ),
        "call_1",
      );
      expectInvalidRequest(
        () =>
          validateChatRequest(
            baseRequest({
              messages: [{ role, content: "hi", toolName: "notes.search" }],
            }),
          ),
        "notes.search",
      );
    }
    // Assistant native toolCalls replay stays valid without top-level ids.
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c0", name: "notes.search", arguments: {} }],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("serializers reject uncorrelated bare tool messages without emitting", () => {
    expectInvalidRequest(() =>
      toOllamaMessage({ role: "tool", content: "bare" }),
    );
    expectInvalidRequest(() =>
      toOllamaMessage({
        role: "tool",
        content: "no-name",
        toolCallId: "c0",
      }),
    );
    expectInvalidRequest(() =>
      toOllamaMessage({
        role: "tool",
        content: "no-id",
        toolName: "notes.search",
      }),
    );
    expectInvalidRequest(() =>
      toOpenAIMessage({ role: "tool", content: "bare" }),
    );
    expectInvalidRequest(() =>
      toOpenAIMessage({
        role: "tool",
        content: "no-name",
        toolCallId: "c0",
      }),
    );
    expectInvalidRequest(() =>
      toOpenAIMessage({
        role: "tool",
        content: "no-id",
        toolName: "notes.search",
      }),
    );
    expectInvalidRequest(() =>
      toOllamaMessage({ role: "user", content: "hi", toolCallId: "c0" }),
    );
    expectInvalidRequest(() =>
      toOpenAIMessage({
        role: "assistant",
        content: "hi",
        toolName: "notes.search",
      }),
    );
  });

  it("gateways reject bare tool requests before fetch", async () => {
    for (const make of [createOllamaGateway, createOpenAICompatibleGateway]) {
      const spy: FetchImpl = async () => {
        throw new Error("fetch must not be called");
      };
      const gateway = make({
        baseUrl: "http://localhost:11434",
        fetchImpl: spy,
      });
      try {
        await gateway.chat(
          baseRequest({
            messages: [{ role: "tool", content: "bare" }],
          }),
        );
        expect.unreachable("should reject bare tool request");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelLocalError);
        expect((error as ModelLocalError).code).toBe("invalid_request");
      }
      try {
        await gateway.chat(
          baseRequest({
            messages: [{ role: "tool", content: "half", toolCallId: "c0" }],
          }),
        );
        expect.unreachable("should reject half-correlated tool request");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelLocalError);
        expect((error as ModelLocalError).code).toBe("invalid_request");
      }
    }
  });
});
