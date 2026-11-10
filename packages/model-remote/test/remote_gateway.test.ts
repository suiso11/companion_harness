import { describe, expect, it } from "vitest";
import {
  createRemoteGateway,
  type RemoteProviderError,
  type RemoteProviderId,
} from "../src/index.js";

const KEY = "sk-secret-key-123";
const messages = [{ role: "user", content: "hi" }] as const;
const ok = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), init);

function gateway(provider: RemoteProviderId, fetchImpl: typeof fetch) {
  return createRemoteGateway({
    provider,
    model: "m-1",
    apiKey: KEY,
    fetchImpl,
  });
}

async function codeOf(p: Promise<unknown>): Promise<RemoteProviderError> {
  try {
    await p;
  } catch (e) {
    return e as RemoteProviderError;
  }
  throw new Error("expected rejection");
}

describe("remote gateway", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com/v1/chat/completions"],
    ["opencode", "https://opencode.ai/inference/openai/v1/chat/completions"],
  ] as const)("sends the expected request for %s", async (provider, url) => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (u: string, init: RequestInit) => {
      seen = { url: u, init };
      return ok({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
    }) as unknown as typeof fetch;
    const result = await gateway(provider, fetchImpl).chat({ messages });
    expect(result).toEqual({
      text: "hello",
      usage: { promptTokens: 3, completionTokens: 4 },
    });
    expect(seen?.url).toBe(url);
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.redirect).toBe("error");
    expect(seen?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(seen?.init.body as string)).toEqual({
      model: "m-1",
      messages,
      [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: 1024,
      stream: false,
    });
  });

  it("forwards an explicit temperature and maxOutputTokens for deepseek", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return ok({ choices: [{ message: { content: "x" } }] });
    }) as unknown as typeof fetch;
    await gateway("deepseek", fetchImpl).chat({
      messages,
      temperature: 0.2,
      maxOutputTokens: 512,
    });
    expect(body).toEqual({
      model: "m-1",
      messages,
      max_tokens: 512,
      temperature: 0.2,
      stream: false,
    });
  });

  it("returns null usage when absent", async () => {
    const g = gateway("openai", (async () =>
      ok({
        choices: [{ message: { content: "x" } }],
      })) as unknown as typeof fetch);
    expect((await g.chat({ messages })).usage).toBeNull();
  });

  it("maps 401 and 403 to unauthorized without leaking the key", async () => {
    for (const status of [401, 403]) {
      const g = gateway(
        "openai",
        (async () =>
          new Response(`bad ${KEY}`, { status })) as unknown as typeof fetch,
      );
      const err = await codeOf(g.chat({ messages }));
      expect(err.code).toBe("unauthorized");
      expect(err.message).not.toContain(KEY);
    }
  });

  it("maps other non-2xx to request_failed and fetch throws too", async () => {
    const g500 = gateway(
      "openai",
      (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof fetch,
    );
    expect((await codeOf(g500.chat({ messages }))).code).toBe("request_failed");
    const gThrow = gateway("openai", (async () => {
      throw new Error(`net ${KEY}`);
    }) as unknown as typeof fetch);
    const err = await codeOf(gThrow.chat({ messages }));
    expect(err.code).toBe("request_failed");
    expect(err.message).not.toContain(KEY);
  });

  it("times out on an already-aborted signal", async () => {
    let called = false;
    const g = gateway("openai", (async () => {
      called = true;
      return ok({});
    }) as unknown as typeof fetch);
    const err = await codeOf(g.chat({ messages, signal: AbortSignal.abort() }));
    expect(err.code).toBe("timeout");
    expect(called).toBe(false);
  });

  it("rejects oversized bodies", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const g = gateway(
      "openai",
      (async () => new Response(big)) as unknown as typeof fetch,
    );
    expect((await codeOf(g.chat({ messages }))).code).toBe(
      "response_too_large",
    );
    const declared = gateway(
      "openai",
      (async () =>
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024) },
        })) as unknown as typeof fetch,
    );
    expect((await codeOf(declared.chat({ messages }))).code).toBe(
      "response_too_large",
    );
  });

  it("rejects malformed JSON and missing content", async () => {
    const bad = gateway(
      "openai",
      (async () => new Response("not json")) as unknown as typeof fetch,
    );
    expect((await codeOf(bad.chat({ messages }))).code).toBe(
      "response_invalid",
    );
    const missing = gateway("openai", (async () =>
      ok({ choices: [{ message: {} }] })) as unknown as typeof fetch);
    expect((await codeOf(missing.chat({ messages }))).code).toBe(
      "response_invalid",
    );
  });

  it("validates construction and request input", async () => {
    const f = (async () => ok({})) as unknown as typeof fetch;
    expect(() =>
      createRemoteGateway({
        provider: "openai",
        model: "bad model",
        apiKey: KEY,
        fetchImpl: f,
      }),
    ).toThrow();
    expect(() =>
      createRemoteGateway({
        provider: "openai",
        model: "m",
        apiKey: "a b",
        fetchImpl: f,
      }),
    ).toThrow();
    expect(() =>
      createRemoteGateway({
        provider: "evil" as RemoteProviderId,
        model: "m",
        apiKey: KEY,
        fetchImpl: f,
      }),
    ).toThrow();
    const g = gateway("openai", f);
    expect(
      (await codeOf(g.chat({ messages, maxOutputTokens: 9000 }))).code,
    ).toBe("invalid_input");
    expect((await codeOf(g.chat({ messages: [] }))).code).toBe("invalid_input");
  });
});
