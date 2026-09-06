import { describe, expect, it, vi } from "vitest";
import { normalizeLoopbackBaseUrl } from "../src/base_url.js";
import { ModelLocalError } from "../src/errors.js";
import {
  assertToolCallingCapability,
  extractModelUsage,
  MAX_MESSAGE_CONTENT_LENGTH,
  validateChatRequest,
} from "../src/gateway.js";
import {
  createOllamaGateway,
  normalizeOllamaResponse,
  toOllamaMessage,
} from "../src/ollama.js";
import {
  createOpenAICompatibleGateway,
  normalizeOpenAIResponse,
  resolveOpenAIChatUrl,
  toOpenAIMessage,
} from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

const SECRET_TOKEN = "secret-token-abc-123";
const SECRET_BODY_MARKER = "super-secret-provider-payload";
const PROMPT_MARKER = "prompt-text-must-not-leak";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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
    messages: [{ role: "user", content: `hello ${PROMPT_MARKER}` }],
    ...overrides,
  };
}

function expectRedacted(error: unknown): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const message = (error as Error).message;
  expect(message).not.toContain(SECRET_TOKEN);
  expect(message).not.toContain(SECRET_BODY_MARKER);
  expect(message).not.toContain(PROMPT_MARKER);
  return error as ModelLocalError;
}

describe("loopback base URLs", () => {
  it("accepts 127.0.0.1, localhost, and ::1 over http", () => {
    expect(normalizeLoopbackBaseUrl("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434",
    );
    expect(normalizeLoopbackBaseUrl("http://localhost:11434/")).toBe(
      "http://localhost:11434",
    );
    expect(normalizeLoopbackBaseUrl("http://[::1]:11434")).toBe(
      "http://[::1]:11434",
    );
  });

  it.each([
    "https://127.0.0.1:11434",
    "https://localhost:11434/v1",
    "http://example.com:11434",
    "http://192.168.1.10:11434",
    "http://0.0.0.0:11434",
    "http://127.0.0.2:11434",
    "http://user:pass@localhost:11434",
    "http://localhost:11434/v1?key=x",
    "http://localhost:11434#frag",
    "not-a-url",
    "",
  ])("rejects %s", (raw) => {
    expect(() => normalizeLoopbackBaseUrl(raw)).toThrowError(ModelLocalError);
  });

  it("rejects credentials without echoing them", () => {
    const raw = "http://user:hunter2@localhost:11434";
    try {
      normalizeLoopbackBaseUrl(raw);
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_base_url");
      expect(err.message).not.toContain("hunter2");
    }
  });
});

describe("bracketed IPv6 loopback serialization", () => {
  it("preserves brackets with ports, paths, and no-port forms", () => {
    expect(normalizeLoopbackBaseUrl("http://[::1]:11434")).toBe(
      "http://[::1]:11434",
    );
    expect(normalizeLoopbackBaseUrl("http://[::1]")).toBe("http://[::1]");
    expect(normalizeLoopbackBaseUrl("http://[::1]:11434/")).toBe(
      "http://[::1]:11434",
    );
    expect(normalizeLoopbackBaseUrl("http://[::1]:11434/prefix/")).toBe(
      "http://[::1]:11434/prefix",
    );
    // Every normalized form must re-parse to a bracketed IPv6 host.
    for (const raw of ["http://[::1]:11434", "http://[::1]"]) {
      const normalized = normalizeLoopbackBaseUrl(raw);
      expect(new URL(normalized).hostname).toContain("::1");
      expect(normalized).toContain("[::1]");
    }
  });

  it.each([
    "http://[::2]:11434",
    "http://[fe80::1]:11434",
    "http://[::ffff:127.0.0.1]:11434",
    "https://[::1]:11434",
    "http://user:pass@[::1]:11434",
    "http://[::1]:11434/?q=1",
    "http://[::1]:11434#frag",
  ])("rejects %s", (raw) => {
    expect(() => normalizeLoopbackBaseUrl(raw)).toThrowError(ModelLocalError);
  });

  it("builds exact bracketed Ollama fetch URLs with and without ports", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        message: { role: "assistant", content: "hi" },
        done: true,
        done_reason: "stop",
      }),
    );
    const gateway = createOllamaGateway({
      baseUrl: "http://[::1]:11434",
      fetchImpl,
    });
    expect(gateway.baseUrl).toBe("http://[::1]:11434");
    expect(gateway.chatUrl).toBe("http://[::1]:11434/api/chat");
    await gateway.chat(baseRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://[::1]:11434/api/chat");

    const noPort = createOllamaGateway({
      baseUrl: "http://[::1]",
      fetchImpl: mockFetch(
        jsonResponse({
          message: { role: "assistant", content: "hi" },
          done: true,
        }),
      ).fetchImpl,
    });
    expect(noPort.chatUrl).toBe("http://[::1]/api/chat");
  });

  it("builds exact bracketed OpenAI fetch URLs with and without ports", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://[::1]:8000",
      fetchImpl,
    });
    expect(gateway.baseUrl).toBe("http://[::1]:8000");
    expect(gateway.chatUrl).toBe("http://[::1]:8000/v1/chat/completions");
    await gateway.chat(baseRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://[::1]:8000/v1/chat/completions");
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("keeps brackets for /v1 bases and no-port OpenAI bases", () => {
    expect(resolveOpenAIChatUrl("http://[::1]:8000/v1")).toBe(
      "http://[::1]:8000/v1/chat/completions",
    );
    expect(resolveOpenAIChatUrl("http://[::1]")).toBe(
      "http://[::1]/v1/chat/completions",
    );
  });
});

describe("capabilities and request validation", () => {
  it("rejects tools when tool calling is unsupported", () => {
    try {
      assertToolCallingCapability({ toolCalling: false }, [
        { name: "notes.search", description: "search" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("unsupported_capability");
    }
  });

  it("allows tool-free requests without tool calling", () => {
    expect(() =>
      assertToolCallingCapability({ toolCalling: false }, undefined),
    ).not.toThrow();
  });

  it("rejects empty models, messages, and duplicate tools", () => {
    expect(() => validateChatRequest(baseRequest({ model: "" }))).toThrowError(
      ModelLocalError,
    );
    expect(() =>
      validateChatRequest(baseRequest({ messages: [] })),
    ).toThrowError(ModelLocalError);
    expect(() =>
      validateChatRequest(
        baseRequest({
          tools: [
            { name: "notes.search", description: "a" },
            { name: "notes.search", description: "b" },
          ],
        }),
      ),
    ).toThrowError(ModelLocalError);
  });
});

describe("ollama adapter", () => {
  it("posts non-streaming /api/chat and returns text", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        message: { role: "assistant", content: "hi there" },
        done: true,
        done_reason: "stop",
      }),
    );
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });
    expect(gateway.chatUrl).toBe("http://127.0.0.1:11434/api/chat");
    const result = await gateway.chat(baseRequest());
    expect(result.text).toBe("hi there");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("error");
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe("test-model");
  });

  it("normalizes native tool_calls without parsing content", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        message: {
          role: "assistant",
          content: `{"name":"notes.search","arguments":{"q":"x"}} ${SECRET_BODY_MARKER}`,
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "notes.search",
                arguments: { q: "x" },
              },
            },
          ],
        },
        done: true,
      }),
    );
    const gateway = createOllamaGateway({
      baseUrl: "http://localhost:11434",
      fetchImpl,
    });
    const result = await gateway.chat(
      baseRequest({
        tools: [{ name: "notes.search", description: "search notes" }],
      }),
    );
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "notes.search", arguments: { q: "x" } },
    ]);
  });

  it("rejects unknown tool names without leaking the body", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [
            {
              function: {
                name: "evil.tool",
                arguments: { marker: SECRET_BODY_MARKER },
              },
            },
          ],
        },
        done: true,
      }),
    );
    const gateway = createOllamaGateway({
      baseUrl: "http://localhost:11434",
      fetchImpl,
    });
    try {
      await gateway.chat(
        baseRequest({
          tools: [{ name: "notes.search", description: "search" }],
        }),
      );
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("tool_call_invalid");
    }
  });

  it("rejects unsolicited tool calls and malformed payloads", async () => {
    const unsolicited = mockFetch(
      jsonResponse({
        message: {
          role: "assistant",
          content: "hi",
          tool_calls: [{ function: { name: "notes.search", arguments: {} } }],
        },
        done: true,
      }),
    );
    await expect(
      createOllamaGateway({
        baseUrl: "http://localhost:11434",
        fetchImpl: unsolicited.fetchImpl,
      }).chat(baseRequest()),
    ).rejects.toMatchObject({ code: "tool_call_invalid" });

    const malformed = mockFetch(jsonResponse({ unexpected: true }));
    await expect(
      createOllamaGateway({
        baseUrl: "http://localhost:11434",
        fetchImpl: malformed.fetchImpl,
      }).chat(baseRequest()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps HTTP failures without exposing bodies or tokens", async () => {
    const { fetchImpl } = mockFetch(
      new Response(SECRET_BODY_MARKER, { status: 500 }),
    );
    try {
      await createOllamaGateway({
        baseUrl: "http://localhost:11434",
        apiKey: SECRET_TOKEN,
        fetchImpl,
      }).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("request_failed");
      expect(err.message).toContain("500");
    }
  });
});

describe("openai-compatible adapter", () => {
  it("posts non-streaming /v1/chat/completions with auth", async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: SECRET_TOKEN,
      fetchImpl,
    });
    expect(gateway.chatUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
    const result = await gateway.chat(baseRequest());
    expect(result.text).toBe("hello");
    expect(result.toolCalls).toEqual([]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(calls[0]?.init?.redirect).toBe("error");
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(sent.stream).toBe(false);
  });

  it("avoids doubling a /v1 base path", () => {
    expect(resolveOpenAIChatUrl("http://localhost:8000/v1")).toBe(
      "http://localhost:8000/v1/chat/completions",
    );
    expect(resolveOpenAIChatUrl("http://localhost:8000")).toBe(
      "http://localhost:8000/v1/chat/completions",
    );
  });

  it("parses native JSON-string tool arguments only", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: `ignore {"tool":"notes.search"} ${SECRET_BODY_MARKER}`,
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: {
                    name: "notes.search",
                    arguments: JSON.stringify({ q: "local" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const result = await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl,
    }).chat(
      baseRequest({
        tools: [{ name: "notes.search", description: "search" }],
      }),
    );
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_9", name: "notes.search", arguments: { q: "local" } },
    ]);
  });

  it("does not emulate tool calls from free-text content", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"name":"notes.search","arguments":{"q":"x"}}',
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const result = await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl,
    }).chat(
      baseRequest({
        tools: [{ name: "notes.search", description: "search" }],
      }),
    );
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain("notes.search");
  });

  it("rejects invalid JSON-string arguments without leaking", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "notes.search",
                    arguments: `{broken ${SECRET_BODY_MARKER}`,
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    try {
      await createOpenAICompatibleGateway({
        baseUrl: "http://localhost:8000",
        apiKey: SECRET_TOKEN,
        fetchImpl,
      }).chat(
        baseRequest({
          tools: [{ name: "notes.search", description: "search" }],
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(expectRedacted(error).code).toBe("tool_call_invalid");
    }
  });

  it("maps transport failures and bad JSON to redacted errors", async () => {
    const failing: FetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      createOpenAICompatibleGateway({
        baseUrl: "http://localhost:8000",
        apiKey: SECRET_TOKEN,
        fetchImpl: failing,
      }).chat(baseRequest()),
    ).rejects.toMatchObject({ code: "transport_error" });

    const badJson: FetchImpl = async () =>
      new Response("not-json{{{", { status: 200 });
    try {
      await createOpenAICompatibleGateway({
        baseUrl: "http://localhost:8000",
        fetchImpl: badJson,
      }).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      expect(expectRedacted(error).code).toBe("invalid_response");
    }
  });

  it("treats redirect rejections as non-followed failures", async () => {
    const redirecting: FetchImpl = async () => {
      throw new TypeError("fetch failed because redirect mode is error");
    };
    await expect(
      createOllamaGateway({
        baseUrl: "http://localhost:11434",
        fetchImpl: redirecting,
      }).chat(baseRequest()),
    ).rejects.toMatchObject({ code: "request_failed" });
    const spy = vi.fn<FetchImpl>(redirecting);
    await expect(
      createOllamaGateway({
        baseUrl: "http://localhost:11434",
        fetchImpl: spy,
      }).chat(baseRequest()),
    ).rejects.toThrowError(/redirect/i);
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

describe("timeout versus transport failures", () => {
  function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
  }

  it("maps aborts to timeout with a fixed safe message", async () => {
    const aborting: FetchImpl = async () => {
      throw abortError();
    };
    try {
      await createOllamaGateway({
        baseUrl: "http://localhost:11434",
        apiKey: SECRET_TOKEN,
        timeoutMs: 50,
        fetchImpl: aborting,
      }).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("timeout");
      expect(err.message).toMatch(/timed out/i);
    }
    try {
      await createOpenAICompatibleGateway({
        baseUrl: "http://localhost:8000",
        apiKey: SECRET_TOKEN,
        timeoutMs: 50,
        fetchImpl: aborting,
      }).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      expect(expectRedacted(error).code).toBe("timeout");
    }
  });

  it("keeps generic transport failures distinct from timeout", async () => {
    const failing: FetchImpl = async () => {
      throw new TypeError(`fetch failed ${SECRET_BODY_MARKER}`);
    };
    await expect(
      createOllamaGateway({
        baseUrl: "http://localhost:11434",
        apiKey: SECRET_TOKEN,
        fetchImpl: failing,
      }).chat(baseRequest()),
    ).rejects.toMatchObject({ code: "transport_error" });
    try {
      await createOpenAICompatibleGateway({
        baseUrl: "http://localhost:8000",
        apiKey: SECRET_TOKEN,
        fetchImpl: failing,
      }).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("transport_error");
      expect(err.message).not.toMatch(/timed out/i);
    }
  });
});

describe("provider usage extraction", () => {
  it("extracts token counts only via the shared helper", () => {
    expect(extractModelUsage(10, 20)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(extractModelUsage(undefined, 20)).toBeUndefined();
    expect(extractModelUsage(10, undefined)).toBeUndefined();
    expect(extractModelUsage(-1, 5)).toBeUndefined();
    expect(extractModelUsage(1.5, 2)).toBeUndefined();
    expect(extractModelUsage("10", "20")).toBeUndefined();
    expect(extractModelUsage(null, null)).toBeUndefined();
  });

  it("reads ollama prompt_eval_count/eval_count without raw blobs", () => {
    const result = normalizeOllamaResponse(
      {
        message: { role: "assistant", content: "hi" },
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 34,
        extra_blob: SECRET_BODY_MARKER,
      },
      undefined,
    );
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(JSON.stringify(result)).not.toContain(SECRET_BODY_MARKER);
  });

  it("omits ollama usage when counts are missing or malformed", () => {
    expect(
      normalizeOllamaResponse(
        { message: { role: "assistant", content: "hi" } },
        undefined,
      ).usage,
    ).toBeUndefined();
    expect(
      normalizeOllamaResponse(
        {
          message: { role: "assistant", content: "hi" },
          prompt_eval_count: -1,
          eval_count: 5,
        },
        undefined,
      ).usage,
    ).toBeUndefined();
  });

  it("reads openai usage.prompt_tokens/completion_tokens only", () => {
    const result = normalizeOpenAIResponse(
      {
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 9,
          total_tokens: 16,
          raw: SECRET_BODY_MARKER,
        },
      },
      undefined,
    );
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 9 });
    expect(JSON.stringify(result)).not.toContain(SECRET_BODY_MARKER);
  });

  it("omits openai usage when absent or malformed", () => {
    expect(
      normalizeOpenAIResponse(
        {
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
        },
        undefined,
      ).usage,
    ).toBeUndefined();
    expect(
      normalizeOpenAIResponse(
        {
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: "7", completion_tokens: 9 },
        },
        undefined,
      ).usage,
    ).toBeUndefined();
  });
});

describe("assistant tool-call history replay", () => {
  const historyCalls = [
    { id: "call_1", name: "notes.search", arguments: { q: "x" } },
    { id: "call_2", name: "notes.open", arguments: {} },
  ];

  it("serializes ollama assistant history as native tool_calls", async () => {
    const entry = toOllamaMessage({
      role: "assistant",
      content: "",
      toolCalls: historyCalls,
    });
    expect(entry.tool_calls).toEqual([
      {
        id: "call_1",
        function: { name: "notes.search", arguments: { q: "x" } },
      },
      { id: "call_2", function: { name: "notes.open", arguments: {} } },
    ]);
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
          { role: "assistant", content: "", toolCalls: historyCalls },
          { role: "tool", content: "feedback", toolCallId: "call_1" },
        ],
      }),
    );
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Record<string, unknown>[];
    };
    expect(sent.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: expect.any(Array),
    });
    expect(sent.messages[2]).toMatchObject({ role: "tool" });
  });

  it("serializes openai assistant history with ids and tool_call_id", async () => {
    const entry = toOpenAIMessage({
      role: "assistant",
      content: "",
      toolCalls: historyCalls,
    });
    expect(entry.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "notes.search",
          arguments: JSON.stringify({ q: "x" }),
        },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "notes.open", arguments: "{}" },
      },
    ]);
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
          { role: "assistant", content: "", toolCalls: historyCalls },
          { role: "tool", content: "feedback", toolCallId: "call_1" },
        ],
      }),
    );
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Record<string, unknown>[];
    };
    expect(sent.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: expect.any(Array),
    });
    expect(sent.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
  });

  it("replays an ordinary-tool multi-step loop end to end", async () => {
    const second = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "final" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl: second.fetchImpl,
    });
    const tools = [{ name: "notes.search", description: "search" }];
    const first = await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl: mockFetch(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "notes.search",
                      arguments: JSON.stringify({ q: "x" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ).fetchImpl,
    }).chat(baseRequest({ tools }));
    expect(first.toolCalls).toHaveLength(1);
    const followUp = await gateway.chat(
      baseRequest({
        tools,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: first.toolCalls },
          { role: "tool", content: '{"hits":[]}', toolCallId: "call_1" },
        ],
      }),
    );
    expect(followUp.text).toBe("final");
    expect(second.calls[0]?.init?.redirect).toBe("error");
  });

  it("rejects tool calls on non-assistant roles and malformed history", () => {
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "user",
              content: "hi",
              toolCalls: [{ id: "c1", name: "notes.search", arguments: {} }],
            },
          ],
        }),
      ),
    ).toThrowError(ModelLocalError);
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "assistant",
              content: "hi",
              toolCalls: [{ id: "", name: "x", arguments: {} }],
            },
          ],
        }),
      ),
    ).toThrowError(ModelLocalError);
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [
            {
              role: "assistant",
              content: "hi",
              toolCalls: [{ id: "c1", name: "x", arguments: "nope" }],
            },
          ],
        }),
      ),
    ).toThrowError(ModelLocalError);
  });

  it("never parses free text as history tool calls", async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"name":"notes.search","arguments":{"q":"x"}}',
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const result = await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl,
    }).chat(
      baseRequest({
        tools: [{ name: "notes.search", description: "search" }],
      }),
    );
    expect(result.toolCalls).toEqual([]);
  });
});

describe("64KiB model-facing tool-result budget", () => {
  it("exposes the 64KiB cap and accepts a legal full-budget result", async () => {
    expect(MAX_MESSAGE_CONTENT_LENGTH).toBe(65_536);
    const fullBudget = "x".repeat(65_536);
    expect(() =>
      validateChatRequest(
        baseRequest({
          messages: [{ role: "tool", content: fullBudget, toolCallId: "c1" }],
        }),
      ),
    ).not.toThrow();
    const { fetchImpl } = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const result = await createOpenAICompatibleGateway({
      baseUrl: "http://localhost:8000",
      fetchImpl,
    }).chat(
      baseRequest({
        messages: [{ role: "tool", content: fullBudget, toolCallId: "c1" }],
      }),
    );
    expect(result.text).toBe("ok");
  });

  it("rejects content above 64KiB without echoing it", () => {
    const over = `prefix ${SECRET_BODY_MARKER} `.padEnd(65_537, "x");
    try {
      validateChatRequest(
        baseRequest({
          messages: [{ role: "tool", content: over, toolCallId: "c1" }],
        }),
      );
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_request");
    }
  });
});
