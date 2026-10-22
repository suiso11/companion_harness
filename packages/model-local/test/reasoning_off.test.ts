// Opt-in reasoning suppression (`ChatRequest.reasoning: "off"`).
//
// The flag is additive: when absent, the request body stays byte-identical
// to the previous serialization. When present, OpenAI-compatible requests
// carry `chat_template_kwargs: { enable_thinking: false }` (forwarded by
// LiteLLM and honored by llama-server) and Ollama requests carry
// `think: false`.

import { describe, expect, it, vi } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { FetchImpl } from "../src/types.js";

const MESSAGES = [{ role: "user" as const, content: "hi" }];

function openaiOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200 },
  );
}

function sseOk(): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function ollamaOk(): Response {
  return new Response(
    JSON.stringify({
      message: { role: "assistant", content: "hi" },
      done: true,
      done_reason: "stop",
    }),
    { status: 200 },
  );
}

function capture(response: Response): {
  fetchImpl: FetchImpl;
  bodies: string[];
} {
  const bodies: string[] = [];
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body));
      return response;
    },
  };
}

describe("reasoning off serialization", () => {
  it("keeps the OpenAI-compatible body byte-identical when absent", async () => {
    const { fetchImpl, bodies } = capture(openaiOk());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }).chat({ model: "m", messages: MESSAGES });
    expect(bodies[0]).toBe(
      JSON.stringify({ model: "m", messages: MESSAGES, stream: false }),
    );
  });

  it("adds only chat_template_kwargs when reasoning off (non-streaming)", async () => {
    const { fetchImpl, bodies } = capture(openaiOk());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }).chat({ model: "m", messages: MESSAGES, reasoning: "off" });
    expect(JSON.parse(bodies[0] as string)).toStrictEqual({
      model: "m",
      messages: MESSAGES,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("adds only chat_template_kwargs when reasoning off (streaming)", async () => {
    const { fetchImpl, bodies } = capture(sseOk());
    await createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
      streamingEnabled: true,
    }).chat({ model: "m", messages: MESSAGES, reasoning: "off" });
    expect(JSON.parse(bodies[0] as string)).toStrictEqual({
      model: "m",
      messages: MESSAGES,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("keeps the Ollama body byte-identical when absent", async () => {
    const { fetchImpl, bodies } = capture(ollamaOk());
    await createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    }).chat({ model: "m", messages: MESSAGES });
    expect(bodies[0]).toBe(
      JSON.stringify({ model: "m", messages: MESSAGES, stream: false }),
    );
  });

  it("adds only think:false when reasoning off (Ollama)", async () => {
    const { fetchImpl, bodies } = capture(ollamaOk());
    await createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    }).chat({ model: "m", messages: MESSAGES, reasoning: "off" });
    expect(JSON.parse(bodies[0] as string)).toStrictEqual({
      model: "m",
      messages: MESSAGES,
      stream: false,
      think: false,
    });
  });

  it("rejects any value other than off before fetch (both adapters)", async () => {
    const openaiFetch = vi.fn<FetchImpl>(async () => openaiOk());
    const ollamaFetch = vi.fn<FetchImpl>(async () => ollamaOk());
    for (const gateway of [
      createOpenAICompatibleGateway({
        baseUrl: "http://127.0.0.1:8000",
        fetchImpl: openaiFetch,
      }),
      createOllamaGateway({
        baseUrl: "http://127.0.0.1:11434",
        fetchImpl: ollamaFetch,
      }),
    ]) {
      await expect(
        gateway.chat({
          model: "m",
          messages: MESSAGES,
          reasoning: "on" as never,
        }),
      ).rejects.toBeInstanceOf(ModelLocalError);
    }
    expect(openaiFetch).not.toHaveBeenCalled();
    expect(ollamaFetch).not.toHaveBeenCalled();
  });
});
