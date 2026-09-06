// Ollama `tool_name` vs OpenAI-compatible `tool_call_id` wire compatibility.
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { validateChatRequest } from "../src/gateway.js";
import {
  createOllamaGateway,
  toOllamaMessage,
} from "../src/ollama.js";
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
          messages: [
            { role: "user", content: "hi", toolName: "notes.search" },
          ],
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
