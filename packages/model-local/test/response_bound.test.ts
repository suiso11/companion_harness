// Provider HTTP response body bound: `postJsonNoRedirect` never calls
// `response.json()` on unbounded data. Success and non-2xx bodies share
// `MAX_RESPONSE_BYTES` (UTF-8 bytes, not JS string length): an oversized
// declared `Content-Length` is rejected before streaming, otherwise the
// stream is read up to max + 1 bytes (absent or dishonest lengths included)
// with the reader cancelled on overflow. Only bytes within the bound are
// decoded (one `TextDecoder` pass, so multibyte sequences split across
// chunks survive) and parsed. Errors are fixed redacted messages (no body,
// URL, apiKey, or prompt); external aborts stay `AbortError` and the
// transport timer/signal listener are cleaned up.

import { describe, expect, it, vi } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { MAX_RESPONSE_BYTES, postJsonNoRedirect } from "../src/gateway.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { FetchImpl } from "../src/types.js";

const SECRET_TOKEN = "secret-token-bound-789";
const SECRET_BODY_MARKER = "bound-secret-payload-marker";
const LOOPBACK_URL = "http://127.0.0.1:11434/api/chat";

const encoder = new TextEncoder();

function ollamaBody(content = "hi"): unknown {
  return {
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
  };
}

function openaiBody(content = "hi"): unknown {
  return {
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
  };
}

function expectRedacted(error: unknown, status?: number): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const message = (error as Error).message;
  expect(message).not.toContain(SECRET_TOKEN);
  expect(message).not.toContain(SECRET_BODY_MARKER);
  expect(message).not.toContain("http://");
  expect(message).not.toContain("127.0.0.1");
  if (status !== undefined) {
    expect(message).toContain(String(status));
  }
  return error as ModelLocalError;
}

/** Single body-reader step (mirrors the stream reader result shape). */
interface BodyStep {
  done: boolean;
  value?: Uint8Array | undefined;
}

/** Streaming body with pull/cancel hooks (asserts reader behavior). */
function trackedStream(
  chunks: Uint8Array[],
  hooks: {
    onPull?: (() => void) | undefined;
    onCancel?: (() => void) | undefined;
  },
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      const next: Uint8Array | undefined = chunks[index];
      if (next === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(next);
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

function streamResponse(
  chunks: Uint8Array[],
  opts: {
    status?: number | undefined;
    headers?: Record<string, string> | undefined;
    onPull?: (() => void) | undefined;
    onCancel?: (() => void) | undefined;
  } = {},
): Response {
  return new Response(
    trackedStream(chunks, { onPull: opts.onPull, onCancel: opts.onCancel }),
    { status: opts.status ?? 200, headers: opts.headers ?? {} },
  );
}

function staticFetch(response: Response): FetchImpl {
  return async () => response;
}

/** Hand-rolled response with a fully controllable body reader. */
function fakeBodyResponse(opts: {
  status: number;
  headers?: Record<string, string> | undefined;
  body: unknown;
}): Response {
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: new Headers(opts.headers),
    body: opts.body,
  } as unknown as Response;
}

/** Minimal reader shape (mirrors the gateway's bounded reader contract). */
interface FakeReader {
  read(): Promise<BodyStep>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** Scripted reader over fixed chunks with a cancel hook. */
function scriptReader(
  chunks: Uint8Array[],
  hooks: { onCancel?: (() => void) | undefined } = {},
): FakeReader {
  let index = 0;
  return {
    read: async (): Promise<BodyStep> => {
      const next: Uint8Array | undefined = chunks[index];
      if (next === undefined) {
        return { done: true, value: undefined };
      }
      index += 1;
      return { done: false, value: next };
    },
    cancel: async (): Promise<void> => {
      hooks.onCancel?.();
    },
    releaseLock: (): void => {},
  };
}

/** Reader that pends until cancelled (mirrors a hung body stream). */
function hangingReader(
  hooks: { onCancel?: (() => void) | undefined } = {},
): FakeReader {
  let rejectRead: (error: unknown) => void = (): void => {};
  return {
    read: (): Promise<BodyStep> =>
      new Promise<BodyStep>((_resolve, reject) => {
        rejectRead = reject;
      }),
    cancel: async (reason?: unknown): Promise<void> => {
      hooks.onCancel?.();
      rejectRead(
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    },
    releaseLock: (): void => {},
  };
}

describe("declared content length", () => {
  it("rejects an oversized declared length before reading (success)", async () => {
    let cancels = 0;
    let readers = 0;
    // A fake body proves the stream is never read: no reader is obtained
    // while the unread body is still released via cancel().
    const fetchImpl = staticFetch(
      fakeBodyResponse({
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
        body: {
          getReader: (): never => {
            readers += 1;
            throw new Error("must not read an oversized body");
          },
          cancel: async (): Promise<void> => {
            cancels += 1;
          },
        },
      }),
    );
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
    expect(readers).toBe(0);
    expect(cancels).toBe(1);
  });

  it("shares the bound across the OpenAI-compatible adapter", async () => {
    const fetchImpl = staticFetch(
      new Response(JSON.stringify(openaiBody("hi")), {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 512) },
      }),
    );
    try {
      await createOpenAICompatibleGateway({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: SECRET_TOKEN,
        fetchImpl,
      }).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
  });
});

describe("chunked, multibyte, and dishonest lengths", () => {
  it("reads chunked bodies without a declared length (both adapters)", async () => {
    const ollamaBytes = encoder.encode(JSON.stringify(ollamaBody("chunked")));
    const ollamaChunks: Uint8Array[] = [];
    for (let i = 0; i < ollamaBytes.length; i += 7) {
      ollamaChunks.push(ollamaBytes.slice(i, i + 7));
    }
    const ollama = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: staticFetch(streamResponse(ollamaChunks)),
    });
    const ollamaResult = await ollama.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ollamaResult.text).toBe("chunked");

    const openaiBytes = encoder.encode(JSON.stringify(openaiBody("chunked")));
    const openaiChunks: Uint8Array[] = [];
    for (let i = 0; i < openaiBytes.length; i += 5) {
      openaiChunks.push(openaiBytes.slice(i, i + 5));
    }
    const openai = createOpenAICompatibleGateway({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: staticFetch(streamResponse(openaiChunks)),
    });
    const openaiResult = await openai.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(openaiResult.text).toBe("chunked");
  });

  it("decodes multibyte characters split across chunks", async () => {
    const content = `héllo 🌍 ${SECRET_BODY_MARKER} tail`;
    const bytes = encoder.encode(JSON.stringify(ollamaBody(content)));
    // 3-byte slices guarantee splits inside multibyte sequences.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      chunks.push(bytes.slice(i, i + 3));
    }
    const gateway = createOllamaGateway({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: staticFetch(streamResponse(chunks)),
    });
    const result = await gateway.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe(content);
  });

  it("catches a dishonest (under-declared) length via the streaming cap", async () => {
    const big = new Uint8Array(65_536);
    big.fill(98);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 17; i += 1) {
      chunks.push(big);
    }
    const fetchImpl = staticFetch(
      streamResponse(chunks, { headers: { "content-length": "16" } }),
    );
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
  });

  it("cancels the reader on streaming overflow", async () => {
    let cancels = 0;
    const big = new Uint8Array(65_536);
    big.fill(98);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 17; i += 1) {
      chunks.push(big);
    }
    const fetchImpl = staticFetch(
      fakeBodyResponse({
        status: 200,
        body: {
          getReader: (): FakeReader =>
            scriptReader(chunks, {
              onCancel: () => {
                cancels += 1;
              },
            }),
        },
      }),
    );
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
    expect(cancels).toBe(1);
  });
});

describe("malformed JSON and non-2xx bodies", () => {
  it("maps malformed JSON within the bound to a redacted error", async () => {
    const fetchImpl = staticFetch(
      new Response(`not-json{{{ ${SECRET_BODY_MARKER}`, { status: 200 }),
    );
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      expect(expectRedacted(error).code).toBe("invalid_response");
    }
  });

  it("reports a small error body by status only", async () => {
    const fetchImpl = staticFetch(
      new Response(SECRET_BODY_MARKER, { status: 500 }),
    );
    try {
      await createOllamaGateway({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: SECRET_TOKEN,
        fetchImpl,
      }).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error, 500);
      expect(err.code).toBe("request_failed");
    }
  });

  it("bounds a streamed oversized error body and still reports status", async () => {
    const big = encoder.encode(`x`.repeat(65_536));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 17; i += 1) {
      chunks.push(big);
    }
    const fetchImpl = staticFetch(streamResponse(chunks, { status: 503 }));
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error, 503);
      expect(err.code).toBe("request_failed");
    }
  });

  it("rejects a declared oversized error body by status only", async () => {
    const fetchImpl = staticFetch(
      new Response(SECRET_BODY_MARKER, {
        status: 500,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
    );
    try {
      await postJsonNoRedirect({
        fetchImpl,
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error, 500);
      expect(err.code).toBe("request_failed");
    }
  });
});

describe("abort and exact boundary", () => {
  it("preserves external abort during body streaming and cancels", async () => {
    let cancels = 0;
    const fetchImpl = staticFetch(
      fakeBodyResponse({
        status: 200,
        body: {
          getReader: (): FakeReader =>
            hangingReader({
              onCancel: () => {
                cancels += 1;
              },
            }),
        },
      }),
    );
    const controller = new AbortController();
    const pending = postJsonNoRedirect({
      fetchImpl,
      url: LOOPBACK_URL,
      body: {},
      apiKey: undefined,
      timeoutMs: undefined,
      signal: controller.signal,
    });
    // Let the fetch resolve and the body read start before aborting, so
    // the abort races an in-flight read (not the pre-read fast path).
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ModelLocalError);
    expect(cancels).toBe(1);
  });

  it("accepts exactly MAX_RESPONSE_BYTES and rejects MAX_RESPONSE_BYTES + 1", async () => {
    // ASCII template: pad with "a" to land exactly on the byte boundary.
    const templateBytes = encoder.encode(`{"ok":true,"pad":""}`).byteLength;
    const exact = `{"ok":true,"pad":"${"a".repeat(MAX_RESPONSE_BYTES - templateBytes)}"}`;
    expect(encoder.encode(exact).byteLength).toBe(MAX_RESPONSE_BYTES);
    const parsed = await postJsonNoRedirect({
      fetchImpl: staticFetch(new Response(exact, { status: 200 })),
      url: LOOPBACK_URL,
      body: {},
      apiKey: undefined,
      timeoutMs: undefined,
    });
    expect((parsed as { ok: boolean }).ok).toBe(true);

    const over = `{"ok":true,"pad":"${"a".repeat(MAX_RESPONSE_BYTES - templateBytes + 1)}"}`;
    expect(encoder.encode(over).byteLength).toBe(MAX_RESPONSE_BYTES + 1);
    try {
      await postJsonNoRedirect({
        fetchImpl: staticFetch(new Response(over, { status: 200 })),
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
  });

  it("enforces byte length, not JS character count", async () => {
    // "é" is 2 UTF-8 bytes: fewer than MAX chars but more than MAX bytes.
    const templateBytes = encoder.encode(`{"ok":true,"pad":""}`).byteLength;
    const count = Math.floor((MAX_RESPONSE_BYTES - templateBytes) / 2) + 1;
    const body = `{"ok":true,"pad":"${"é".repeat(count)}"}`;
    expect(body.length).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(encoder.encode(body).byteLength).toBeGreaterThan(MAX_RESPONSE_BYTES);
    try {
      await postJsonNoRedirect({
        fetchImpl: staticFetch(new Response(body, { status: 200 })),
        url: LOOPBACK_URL,
        body: {},
        apiKey: SECRET_TOKEN,
        timeoutMs: undefined,
      });
      expect.unreachable();
    } catch (error) {
      const err = expectRedacted(error);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toMatch(/oversized/i);
    }
  });

  it("clears the transport timer after a bounded read", async () => {
    vi.useFakeTimers();
    try {
      const result = await postJsonNoRedirect({
        fetchImpl: staticFetch(
          new Response(JSON.stringify(ollamaBody("hi")), { status: 200 }),
        ),
        url: LOOPBACK_URL,
        body: {},
        apiKey: undefined,
        timeoutMs: 1000,
      });
      expect(result).toMatchObject({ message: { content: "hi" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
