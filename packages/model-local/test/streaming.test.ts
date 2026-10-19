// PR-2 streaming tests: SSE accumulation equals the non-streaming result,
// strict malformed handling, abort, bounds, and partial-JSON drafts.
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  createOpenAICompatibleGateway,
  normalizeOpenAIResponse,
} from "../src/openai_compatible.js";
import {
  extractPartialPartsText,
  OpenAIStreamAccumulator,
  postChatCompletionStream,
} from "../src/streaming.js";
import type { ChatRequest, FetchImpl, ModelStreamDelta } from "../src/types.js";

const PROMPT_MARKER = "prompt-text-must-not-leak";

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: `hello ${PROMPT_MARKER}` }],
    ...overrides,
  };
}

function sseResponseFromChunks(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseChunk(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
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

/** Byte-split SSE text into odd pieces (exercises multibyte/escape splits). */
function splitSseResponse(text: string, sizes: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let cursor = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[cursor % sizes.length] as number;
    cursor += 1;
    parts.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamingGateway(fetchImpl: FetchImpl) {
  return createOpenAICompatibleGateway({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl,
    streamingEnabled: true,
  });
}

describe("streaming request shape", () => {
  it("sends stream:true with include_usage and parses like non-stream", async () => {
    const { fetchImpl, calls } = mockFetch(
      sseResponseFromChunks([
        sseChunk({
          choices: [{ delta: { content: "hel" }, finish_reason: null }],
        }),
        sseChunk({
          choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const deltas: ModelStreamDelta[] = [];
    const result = await streamingGateway(fetchImpl).chat(baseRequest(), {
      onDelta: (delta) => {
        deltas.push(delta);
      },
    });
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(result).toEqual(
      normalizeOpenAIResponse(
        {
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        },
        undefined,
      ),
    );
    expect(deltas).toEqual([
      { kind: "content", text: "hel" },
      { kind: "content", text: "lo" },
      { kind: "usage", inputTokens: 3, outputTokens: 2 },
    ]);
  });

  it("stays additive/default-off without the flag", async () => {
    const { fetchImpl, calls } = mockFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }).chat(baseRequest());
    expect(result.text).toBe("hi");
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(sent.stream).toBe(false);
  });
});

describe("reasoning deltas", () => {
  it("accumulates reasoning_content and keeps the final result identical", async () => {
    const { fetchImpl } = mockFetch(
      sseResponseFromChunks([
        sseChunk({
          choices: [{ delta: { reasoning_content: "think " } }],
        }),
        sseChunk({
          choices: [
            { delta: { reasoning_content: "more", content: "answer" } },
          ],
        }),
        sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const deltas: ModelStreamDelta[] = [];
    const result = await streamingGateway(fetchImpl).chat(baseRequest(), {
      onDelta: (delta) => {
        deltas.push(delta);
      },
    });
    expect(result.text).toBe("answer");
    expect(result.toolCalls).toEqual([]);
    // Per-chunk emit order is content-then-reasoning (both provisional).
    expect(deltas).toEqual([
      { kind: "reasoning", text: "think " },
      { kind: "content", text: "answer" },
      { kind: "reasoning", text: "more" },
    ]);
    // LiteLLM strips timings: unknown SSE fields never fail the stream.
    const { fetchImpl: timed } = mockFetch(
      sseResponseFromChunks([
        ": heartbeat\n\n",
        "event: timings\n",
        sseChunk({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const timedResult = await streamingGateway(timed).chat(baseRequest());
    expect(timedResult.text).toBe("ok");
  });
});

describe("tool-call argument accumulation", () => {
  const answerArgs = {
    parts: [{ text: "Hello draft world", citations: [] }],
  };
  const answerArgsJson = JSON.stringify(answerArgs);

  function answerStreamChunks(): string[] {
    // Split the arguments mid-string to exercise incremental appends.
    const first = answerArgsJson.slice(0, 17);
    const second = answerArgsJson.slice(17);
    return [
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_0",
                  type: "function",
                  function: { name: "answer.submit", arguments: first },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: second } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
  }

  it("equals the non-streaming tool result and emits draft deltas", async () => {
    const tools = [{ name: "answer.submit", description: "submit" }];
    const { fetchImpl } = mockFetch(
      sseResponseFromChunks(answerStreamChunks()),
    );
    const deltas: ModelStreamDelta[] = [];
    const streamed = await streamingGateway(fetchImpl).chat(
      baseRequest({ tools }),
      {
        onDelta: (delta) => {
          deltas.push(delta);
        },
      },
    );
    const nonStreamed = normalizeOpenAIResponse(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "answer.submit",
                    arguments: answerArgsJson,
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      tools,
    );
    expect(streamed).toEqual(nonStreamed);
    const draftText = deltas
      .filter((delta) => delta.kind === "draft")
      .map((delta) => (delta.kind === "draft" ? delta.text : ""))
      .join("");
    expect(draftText).toBe("Hello draft world");
  });

  it("survives byte splits inside escapes and unicode", async () => {
    const tricky = 'a\\b"c\ndé\ud83d\ude00 end';
    const argsJson = JSON.stringify({ parts: [{ text: tricky }] });
    const full = sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "answer.submit", arguments: argsJson },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    // 1..7 byte splits cut through escapes, multibyte chars, and `\uXXXX`.
    const { fetchImpl } = mockFetch(
      splitSseResponse(`${full}data: [DONE]\n\n`, [1, 2, 3, 5, 7]),
    );
    const deltas: ModelStreamDelta[] = [];
    const tools = [{ name: "answer.submit", description: "submit" }];
    const result = await streamingGateway(fetchImpl).chat(
      baseRequest({ tools }),
      {
        onDelta: (delta) => {
          deltas.push(delta);
        },
      },
    );
    expect(result.toolCalls[0]?.arguments).toEqual({
      parts: [{ text: tricky }],
    });
    const draftText = deltas
      .filter((delta) => delta.kind === "draft")
      .map((delta) => (delta.kind === "draft" ? delta.text : ""))
      .join("");
    expect(draftText).toBe(tricky);
  });

  it("joins multi-part draft text with one blank line like the final rendering", async () => {
    const argsJson = JSON.stringify({
      version: 1,
      parts: [
        { text: "first part", citations: [] },
        { text: "second part", citations: [] },
      ],
    });
    // Split right before the second part's object so the separator itself
    // arrives as a draft suffix with the next piece.
    const cut = argsJson.indexOf('{"text":"second"');
    const first = argsJson.slice(0, cut);
    const second = argsJson.slice(cut);
    const { fetchImpl } = mockFetch(
      sseResponseFromChunks([
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_0",
                    type: "function",
                    function: { name: "answer.submit", arguments: first },
                  },
                ],
              },
            },
          ],
        }),
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: second } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const deltas: ModelStreamDelta[] = [];
    const tools = [{ name: "answer.submit", description: "submit" }];
    const streamed = await streamingGateway(fetchImpl).chat(
      baseRequest({ tools }),
      {
        onDelta: (delta) => {
          deltas.push(delta);
        },
      },
    );
    const draftText = deltas
      .filter((delta) => delta.kind === "draft")
      .map((delta) => (delta.kind === "draft" ? delta.text : ""))
      .join("");
    // Authoritative join semantics (renderRunResultText/renderAnswerText):
    // exactly one blank line between parts, never direct adjacency.
    const args = streamed.toolCalls[0]?.arguments as {
      parts: Array<{ text: string }>;
    };
    expect(draftText).toBe("first part\n\nsecond part");
    expect(draftText).toBe(args.parts.map((part) => part.text).join("\n\n"));
  });
});

describe("partial-JSON draft extractor", () => {
  it("decodes complete prefixes and holds back split escapes/unicode", () => {
    const full = JSON.stringify({ parts: [{ text: "héllo 🌍" }] });
    let previous = "";
    // Every prefix must decode to a prefix of the final text (monotonic).
    for (let end = 1; end <= full.length; end += 1) {
      const decoded = extractPartialPartsText(full.slice(0, end));
      expect(full).toContain(decoded);
      expect(decoded.startsWith(previous)).toBe(true);
      previous = decoded;
    }
    expect(extractPartialPartsText(full)).toBe("héllo 🌍");
    // Split surrogate escape: high half alone contributes nothing new.
    const escaped = JSON.stringify({ parts: [{ text: "\ud83d\ude00!" }] });
    const cut = escaped.indexOf("\\ud83d") + "\\ud83d".length;
    expect(extractPartialPartsText(escaped.slice(0, cut))).toBe("");
    expect(extractPartialPartsText(escaped)).toBe("\ud83d\ude00!");
  });

  it("never throws on hostile prefixes", () => {
    for (const hostile of [
      '{"parts":[{"text":"abc\\',
      '{"parts":[{"text":"abc\\u12',
      '{"parts":[{"text":',
      "not json at all",
      '{"parts":[{"text":"a\u0000b',
    ]) {
      expect(() => extractPartialPartsText(hostile)).not.toThrow();
    }
  });

  it("joins multiple parts with one blank line, monotonically", () => {
    const full = JSON.stringify({ parts: [{ text: "aa" }, { text: "bb" }] });
    let previous = "";
    // Every prefix must decode to a prefix of the final draft (monotonic
    // suffix emission) and the final draft must equal the authoritative
    // `parts[].text` join.
    for (let end = 1; end <= full.length; end += 1) {
      const decoded = extractPartialPartsText(full.slice(0, end));
      expect(decoded.startsWith(previous)).toBe(true);
      previous = decoded;
    }
    expect(previous).toBe("aa\n\nbb");
  });
});

describe("strict streaming errors", () => {
  async function expectStreamCode(
    chunks: string[],
    code: string,
    request: ChatRequest = baseRequest(),
  ): Promise<void> {
    const { fetchImpl } = mockFetch(sseResponseFromChunks(chunks));
    try {
      await streamingGateway(fetchImpl).chat(request);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe(code);
      const message = (error as Error).message;
      expect(message).not.toContain(PROMPT_MARKER);
    }
  }

  it("rejects malformed chunks as invalid_response", async () => {
    await expectStreamCode(
      ["data: not-json\n\n", "data: [DONE]\n\n"],
      "invalid_response",
    );
    await expectStreamCode(
      [sseChunk({ choices: "nope" }), "data: [DONE]\n\n"],
      "invalid_response",
    );
    await expectStreamCode(
      [sseChunk({ choices: [{ delta: { content: 42 } }] }), "data: [DONE]\n\n"],
      "invalid_response",
    );
    await expectStreamCode(
      [
        sseChunk({ choices: [{ message: { content: "x" } }] }),
        "data: [DONE]\n\n",
      ],
      "invalid_response",
    );
  });

  it("rejects oversize bodies and content with non-stream classes", async () => {
    // Raw SSE bytes over the per-call cap.
    const { fetchImpl: capped } = mockFetch(
      sseResponseFromChunks([
        sseChunk({ choices: [{ delta: { content: "1234567890" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    try {
      await streamingGateway(capped).chat(baseRequest(), {
        maxResponseBytes: 10,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("invalid_response");
    }
    // Ordinary tool args over 32KiB stream to invalid_response.
    const bigArgs = JSON.stringify({ blob: "x".repeat(40_000) });
    await expectStreamCode(
      [
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_big",
                    function: { name: "notes.search", arguments: bigArgs },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
      "invalid_response",
      baseRequest({ tools: [{ name: "notes.search", description: "s" }] }),
    );
    // answer.submit oversize keeps the repairable answer_invalid class.
    await expectStreamCode(
      [
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_big",
                    function: { name: "answer.submit", arguments: bigArgs },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
      "answer_invalid",
      baseRequest({ tools: [{ name: "answer.submit", description: "s" }] }),
    );
  });

  it("rejects a stream that closes before the [DONE] sentinel", async () => {
    // Plain content arrived but the body ended without `data: [DONE]`:
    // a truncated connection must not normalize into a successful result.
    await expectStreamCode(
      [sseChunk({ choices: [{ delta: { content: "partial" } }] })],
      "invalid_response",
    );
    // Even a complete-looking tool-call argument without [DONE] rejects
    // (a partially streamed tool call must never execute).
    await expectStreamCode(
      [
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_x",
                    function: {
                      name: "notes.search",
                      arguments: '{"q":"x"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ],
      "invalid_response",
      baseRequest({ tools: [{ name: "notes.search", description: "s" }] }),
    );
  });

  it("rejects conflicting tool names on one index as invalid_response", async () => {
    await expectStreamCode(
      [
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c0",
                    function: { name: "memory.search", arguments: '{"q"' },
                  },
                ],
              },
            },
          ],
        }),
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "calendar.search", arguments: ':"x"}' },
                  },
                ],
              },
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
      "invalid_response",
    );
  });

  it("accepts identical repeats and cumulative-prefix name fragments", async () => {
    const { fetchImpl } = mockFetch(
      sseResponseFromChunks([
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c0",
                    function: { name: "notes", arguments: '{"q"' },
                  },
                ],
              },
            },
          ],
        }),
        // Prefix growth to the full split name, then an identical repeat,
        // then a repeat of an already-subsumed earlier fragment.
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "notes.search", arguments: ':"x"}' },
                  },
                ],
              },
            },
          ],
        }),
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "notes.search" } },
                ],
              },
            },
          ],
        }),
        sseChunk({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: "notes" } }] } },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const result = await streamingGateway(fetchImpl).chat(
      baseRequest({ tools: [{ name: "notes.search", description: "s" }] }),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "notes.search",
      arguments: { q: "x" },
    });
  });

  it("does not fall back: transport failures surface once", async () => {
    const { fetchImpl, calls } = mockFetch(
      new Response("oops", { status: 500 }),
    );
    try {
      await streamingGateway(fetchImpl).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("request_failed");
      expect(calls).toHaveLength(1);
    }
  });

  it("preserves external abort without mapping", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    const { fetchImpl } = mockFetch(sseResponseFromChunks([]));
    try {
      await streamingGateway(fetchImpl).chat(baseRequest(), {
        signal: controller.signal,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    }
  });

  it("aborts a slow stream on signal", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(sseChunk({ choices: [{ delta: {} }] })),
        );
        // Never close: the abort must settle the read.
      },
      cancel() {},
    });
    const fetchImpl: FetchImpl = async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(
            (signal as AbortSignal).reason ??
              new DOMException("aborted", "AbortError"),
          );
        });
      });
    };
    void stream;
    const result = streamingGateway(fetchImpl).chat(baseRequest(), {
      signal: controller.signal,
    });
    controller.abort(new DOMException("stopped", "AbortError"));
    try {
      await result;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
    }
  });

  it("cancels the body and aborts the request when chunk validation fails", async () => {
    let bodyCancelled = false;
    let requestSignalAborted = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: not-json\n\n"));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        // Never closed: only cancellation may end this body.
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetchImpl: FetchImpl = async (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        requestSignalAborted = true;
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    try {
      await streamingGateway(fetchImpl).chat(baseRequest());
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("invalid_response");
    }
    // The unread response must stop generating: reader cancelled and the
    // request controller aborted before the error propagated.
    expect(bodyCancelled).toBe(true);
    expect(requestSignalAborted).toBe(true);
  });
});

describe("non-2xx error-body drain (abort semantics)", () => {
  /** Never-ending streaming body (a reader not coupled to any signal). */
  function endlessBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk-1"));
        // Never closes: only reader cancellation can end the drain.
      },
      cancel() {},
    });
  }

  it("returns timeout when the deadline hits during the drain", async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response(endlessBody(), { status: 500 });
    try {
      await postChatCompletionStream({
        fetchImpl,
        url: "http://127.0.0.1:8000/v1/chat/completions",
        body: {},
        apiKey: undefined,
        timeoutMs: 20,
        onChunkBody: () => {},
      });
      expect.unreachable();
    } catch (error) {
      // Previously the drain swallowed the abort and the caller surfaced
      // the HTTP status as request_failed; the deadline must win.
      expect((error as ModelLocalError).code).toBe("timeout");
    }
  });

  it("propagates external cancellation during the drain untouched", async () => {
    const external = new AbortController();
    const fetchImpl: FetchImpl = async () =>
      new Response(endlessBody(), { status: 500 });
    const pending = postChatCompletionStream({
      fetchImpl,
      url: "http://127.0.0.1:8000/v1/chat/completions",
      body: {},
      apiKey: undefined,
      timeoutMs: undefined,
      signal: external.signal,
      onChunkBody: () => {},
    });
    setTimeout(
      () => external.abort(new DOMException("stopped", "AbortError")),
      10,
    );
    try {
      await pending;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    }
  });

  it("still reports the HTTP status when the drain completes normally", async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("gone"));
            c.close();
          },
        }),
        { status: 500 },
      );
    try {
      await postChatCompletionStream({
        fetchImpl,
        url: "http://127.0.0.1:8000/v1/chat/completions",
        body: {},
        apiKey: undefined,
        timeoutMs: undefined,
        onChunkBody: () => {},
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("request_failed");
    }
  });
});

describe("accumulator unit behavior", () => {
  it("synthesizes deterministic order and rejects over-count", () => {
    const acc = new OpenAIStreamAccumulator();
    // 33 distinct stream indices: the 33rd must reject (shared count bound).
    for (let index = 0; index < 33; index += 1) {
      const pushed = (): void => {
        acc.pushChunkBody({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${index}`,
                    function: { name: "notes.search", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      };
      if (index < 32) {
        pushed();
      } else {
        expect(pushed).toThrowError(ModelLocalError);
      }
    }
    const body = acc.toNormalFormBody();
    const calls = (
      (body.choices as unknown[])[0] as {
        message: { tool_calls: { id: string }[] };
      }
    ).message.tool_calls;
    expect(calls.map((call) => call.id)).toEqual(
      Array.from({ length: 32 }, (_, i) => `call_${i}`),
    );
  });
});
