// ModelGateway abort propagation: the optional per-step AbortSignal must
// actually cancel the underlying fetch (not a Promise.race alone), compose
// with the transport timeout guard, and clean up timers/listeners. No
// secrets, prompts, bodies, or URLs are asserted verbatim beyond loopback
// endpoints already covered elsewhere.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function baseRequest(): ChatRequest {
  return { model: "test-model", messages: [{ role: "user", content: "hi" }] };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ollamaOk(): Response {
  return jsonResponse({
    message: { role: "assistant", content: "hi" },
    done: true,
    done_reason: "stop",
  });
}

function openaiOk(): Response {
  return jsonResponse({
    choices: [
      { message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
    ],
  });
}

/** Mock fetch that behaves like real fetch: rejects on signal abort. */
function abortableFetch(opts: {
  captured: { signal?: AbortSignal | null };
  response: Response;
}): FetchImpl {
  return (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      opts.captured.signal = signal;
      if (signal?.aborted === true) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
      // Resolve on the next microtask unless aborted first.
      queueMicrotask(() => {
        if (signal?.aborted === true) return;
        resolve(opts.response);
      });
    });
}

/** Mock fetch that never resolves unless its signal aborts (hung server). */
function hangingFetch(captured: { signal?: AbortSignal | null }): FetchImpl {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      captured.signal = signal;
      if (signal?.aborted === true) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
}

describe("gateway abort propagation", () => {
  it("forwards external cancellation to fetch and preserves AbortError (ollama)", async () => {
    const captured: { signal?: AbortSignal | null } = {};
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: abortableFetch({ captured, response: ollamaOk() }),
    });
    const controller = new AbortController();
    const pending = gateway.chat(baseRequest(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(captured.signal?.aborted).toBe(true);
  });

  it("forwards external cancellation to fetch and preserves AbortError (openai-compatible)", async () => {
    const captured: { signal?: AbortSignal | null } = {};
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: abortableFetch({ captured, response: openaiOk() }),
    });
    const controller = new AbortController();
    const pending = gateway.chat(baseRequest(), { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    // Cancellation is distinct from timeout: never mapped to ModelLocalError.
    expect(error).not.toBeInstanceOf(ModelLocalError);
    expect(captured.signal?.aborted).toBe(true);
  });

  it("aborts the HTTP fetch on the 120s step timeout (fake timers)", async () => {
    vi.useFakeTimers();
    const captured: { signal?: AbortSignal | null } = {};
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 120_000,
      fetchImpl: hangingFetch(captured),
    });
    const pending = gateway.chat(baseRequest());
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(captured.signal?.aborted).toBe(true);
  });

  it("prefers external cancellation over the transport timeout guard", async () => {
    vi.useFakeTimers();
    const captured: { signal?: AbortSignal | null } = {};
    const gateway = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      timeoutMs: 120_000,
      fetchImpl: hangingFetch(captured),
    });
    const controller = new AbortController();
    const pending = gateway.chat(baseRequest(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(captured.signal?.aborted).toBe(true);
    // Advancing past the transport timeout must not reclassify or throw.
    await vi.advanceTimersByTimeAsync(120_000);
  });

  it("never calls fetch when the signal is already aborted", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => ollamaOk());
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.chat(baseRequest(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears the timeout timer and signal listener on success", async () => {
    vi.useFakeTimers();
    const captured: { signal?: AbortSignal | null } = {};
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 120_000,
      fetchImpl: abortableFetch({ captured, response: ollamaOk() }),
    });
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const result = await gateway.chat(baseRequest(), {
      signal: controller.signal,
    });
    expect(result.text).toBe("hi");
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
