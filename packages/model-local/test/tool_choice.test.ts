// tool_choice request-body policy for the OpenAI-compatible adapter:
// `required` (default) with tools, explicit `auto`, omitted without tools,
// strict validation, and the Ollama adapter staying unaffected.
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

const TOOLS = [{ name: "notes.search", description: "search" }];

function openaiResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sseResponse(): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(chunks, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function capture(response: Response): {
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

function firstBody(
  calls: { init: RequestInit | undefined }[],
): Record<string, unknown> {
  const call = calls[0];
  if (call === undefined) throw new Error("no fetch call");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe("openai-compatible tool_choice", () => {
  it("defaults to required when tools are offered (stream:false)", async () => {
    const { fetchImpl, calls } = capture(openaiResponse());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }).chat(baseRequest({ tools: TOOLS }));
    expect(firstBody(calls).tool_choice).toBe("required");
  });

  it("defaults to required when tools are offered (streaming)", async () => {
    const { fetchImpl, calls } = capture(sseResponse());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
      streamingEnabled: true,
    }).chat(baseRequest({ tools: TOOLS }));
    expect(firstBody(calls).tool_choice).toBe("required");
    expect(firstBody(calls).stream).toBe(true);
  });

  it("honours an explicit auto policy", async () => {
    const { fetchImpl, calls } = capture(openaiResponse());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
      toolChoice: "auto",
    }).chat(baseRequest({ tools: TOOLS }));
    expect(firstBody(calls).tool_choice).toBe("auto");
  });

  it("honours an explicit required policy", async () => {
    const { fetchImpl, calls } = capture(openaiResponse());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
      toolChoice: "required",
    }).chat(baseRequest({ tools: TOOLS }));
    expect(firstBody(calls).tool_choice).toBe("required");
  });

  it("omits tool_choice when no tools are offered", async () => {
    const { fetchImpl, calls } = capture(openaiResponse());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }).chat(baseRequest());
    expect(firstBody(calls).tools).toBeUndefined();
    expect("tool_choice" in firstBody(calls)).toBe(false);
  });

  it("rejects an unknown toolChoice value", () => {
    expect(() =>
      createOpenAICompatibleGateway({
        baseUrl: "http://127.0.0.1:8000",
        fetchImpl: async () => openaiResponse(),
        toolChoice: "none" as never,
      }),
    ).toThrowError(ModelLocalError);
  });

  it("leaves the Ollama adapter wire format untouched", async () => {
    const { fetchImpl, calls } = capture(
      new Response(
        JSON.stringify({
          message: { content: "hello" },
          done_reason: "stop",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
      toolChoice: "required",
    }).chat(baseRequest({ tools: TOOLS }));
    expect("tool_choice" in firstBody(calls)).toBe(false);
  });
});
