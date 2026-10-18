// Per-call caps: `ChatRequest.maxOutputTokens` serialization and the
// per-call `maxResponseBytes` response bound. Mock fetch only.

import { describe, expect, it, vi } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { MAX_RESPONSE_BYTES } from "../src/gateway.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { FetchImpl } from "../src/types.js";

const encoder = new TextEncoder();

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

function capturingFetch(
  response: Response,
  captured: { body?: unknown },
): FetchImpl {
  return async (_url, init) => {
    captured.body = JSON.parse(String(init?.body));
    return response;
  };
}

describe("maxOutputTokens serialization", () => {
  it("sends max_tokens only when set (openai-compatible)", async () => {
    const captured: { body?: unknown } = {};
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: capturingFetch(openaiOk(), captured),
    });
    await gateway.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 64,
    });
    expect((captured.body as Record<string, unknown>).max_tokens).toBe(64);

    const plain: { body?: unknown } = {};
    const gateway2 = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: capturingFetch(openaiOk(), plain),
    });
    await gateway2.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect("max_tokens" in (plain.body as Record<string, unknown>)).toBe(false);
  });

  it("sends options.num_predict only when set (ollama)", async () => {
    const captured: { body?: unknown } = {};
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: capturingFetch(ollamaOk(), captured),
    });
    await gateway.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 32,
    });
    expect(captured.body).toMatchObject({ options: { num_predict: 32 } });

    const plain: { body?: unknown } = {};
    const gateway2 = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: capturingFetch(ollamaOk(), plain),
    });
    await gateway2.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect("options" in (plain.body as Record<string, unknown>)).toBe(false);
  });

  it("rejects invalid maxOutputTokens before fetch (both adapters)", async () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      for (const gateway of [
        createOllamaGateway({
          baseUrl: "http://127.0.0.1:11434",
          fetchImpl: vi.fn<FetchImpl>(async () => ollamaOk()),
        }),
        createOpenAICompatibleGateway({
          baseUrl: "http://127.0.0.1:8000",
          fetchImpl: vi.fn<FetchImpl>(async () => openaiOk()),
        }),
      ]) {
        try {
          await gateway.chat({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            maxOutputTokens: bad,
          });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(ModelLocalError);
          expect((error as ModelLocalError).code).toBe("invalid_request");
        }
      }
    }
    // Ensure fetch is not called for an invalid cap.
    const fetchImpl = vi.fn<FetchImpl>(async () => ollamaOk());
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });
    await expect(
      gateway.chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("per-call maxResponseBytes", () => {
  it("rejects overflow with dishonest/absent Content-Length, passes within cap", async () => {
    const cap = 256;
    const big = new Response("x".repeat(cap + 1), {
      status: 200,
      headers: { "content-length": "16" },
    });
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: async () => big,
    });
    await expect(
      gateway.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { maxResponseBytes: cap },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });

    // Within cap passes.
    const okBody = JSON.stringify({
      message: { role: "assistant", content: "hi" },
      done: true,
      done_reason: "stop",
    });
    expect(encoder.encode(okBody).byteLength).toBeLessThanOrEqual(cap);
    const gateway2 = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: async () => new Response(okBody, { status: 200 }),
    });
    const result = await gateway2.chat(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { maxResponseBytes: cap },
    );
    expect(result.text).toBe("hi");

    // Declared oversized relative to the per-call cap rejects before reading.
    const declared = new Response(okBody, {
      status: 200,
      headers: { "content-length": String(cap + 1) },
    });
    const gateway3 = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: async () => declared,
    });
    await expect(
      gateway3.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { maxResponseBytes: cap },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });

    // Absent cap preserves default ceiling.
    const gateway4 = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: async () => new Response(okBody, { status: 200 }),
    });
    const plain = await gateway4.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plain.text).toBe("hi");
    expect(MAX_RESPONSE_BYTES).toBe(1_048_576);
  });

  it("rejects invalid maxResponseBytes before fetch", async () => {
    for (const bad of [0, -1, 1.5, MAX_RESPONSE_BYTES + 1, NaN]) {
      const fetchImpl = vi.fn<FetchImpl>(async () => ollamaOk());
      const gateway = createOllamaGateway({
        baseUrl: "http://127.0.0.1:11434",
        fetchImpl,
      });
      await expect(
        gateway.chat(
          { model: "m", messages: [{ role: "user", content: "hi" }] },
          { maxResponseBytes: bad },
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
