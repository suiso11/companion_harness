import { mkdtempSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { validateChatRequest } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { createCollectingLogger } from "../src/logger.js";
import {
  TrialModelRelay,
  type TrialModelRelayCaps,
} from "../src/trial_model_relay.js";

const FIXED_MODEL = "companion-current";

function testCaps(
  over: Partial<TrialModelRelayCaps> = {},
): TrialModelRelayCaps {
  return {
    maxRequestBytes: 16 * 1024 * 1024,
    maxModelCalls: 8,
    maxOutputTokens: 1024,
    maxResponseBytes: 1 * 1024 * 1024,
    perCallTimeoutMs: 5000,
    maxConcurrent: 1,
    ...over,
  };
}

interface FakeGatewayOpts {
  result?: ChatResult;
  hang?: boolean;
  onChat?: (request: ChatRequest, options?: unknown) => void;
  signalSeen?: { current: AbortSignal | null };
}

function fakeGateway(
  opts: FakeGatewayOpts = {},
): ModelGateway & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const gw = {
    calls,
    provider: "openai-compatible" as const,
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:9",
    chatUrl: "http://127.0.0.1:9/v1/chat/completions",
    async chat(
      request: ChatRequest,
      options?: { signal?: AbortSignal },
    ): Promise<ChatResult> {
      calls.push(request);
      opts.onChat?.(request, options);
      if (opts.signalSeen !== undefined && options?.signal !== undefined) {
        opts.signalSeen.current = options.signal;
      }
      if (opts.hang === true) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }
      return (
        opts.result ?? {
          text: "hello",
          toolCalls: [],
          stopReason: "stop" as const,
        }
      );
    },
  };
  return gw;
}

function postUds(
  sockPath: string,
  body: string,
  stream?: boolean,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  void stream;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sockPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function chatBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "companion/companion-current",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  });
}

async function startRelay(
  caps: TrialModelRelayCaps,
  gw: ModelGateway,
): Promise<{ relay: TrialModelRelay; sock: string }> {
  const dir = mkdtempSync(join(tmpdir(), "trial-relay-"));
  const sock = join(dir, "relay", "model.sock");
  const relay = new TrialModelRelay({
    sockPath: sock,
    gateway: gw,
    fixedModel: FIXED_MODEL,
    caps,
  });
  await relay.start();
  return { relay, sock };
}

// Linux-only: the trial relay binds a unix-domain socket with POSIX 0700/0600
// permissions. Windows runners lack unix-socket + chmod semantics (EACCES on
// model.sock), so the whole suite is skipped there; the relay is only
// deployed on systemd Linux hosts.
describe.skipIf(process.platform === "win32")("trial_model_relay", () => {
  it("socket lives in a 0700 dir with 0600 mode", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      const dirStat = statSync(join(sock, ".."));
      expect(dirStat.mode & 0o777).toBe(0o700);
      const sockStat = statSync(sock);
      expect(sockStat.mode & 0o777).toBe(0o600);
    } finally {
      await relay.close();
    }
    expect(() => statSync(sock)).toThrow();
  });

  it("pre-permit request waits bounded then refuses without forwarding", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(
      testCaps({ perCallTimeoutMs: 120 }),
      gw,
    );
    try {
      const started = Date.now();
      const res = await postUds(sock, chatBody());
      // Bounded wait for the runner permit, then a fixed error.
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text).error.message).toBe("relay_not_permitted");
      expect(gw.calls.length).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("pre-permit request proceeds once the runner permit lands", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(
      testCaps({ perCallTimeoutMs: 2000 }),
      gw,
    );
    try {
      const pending = postUds(sock, chatBody());
      await new Promise((r) => setTimeout(r, 50));
      relay.setPermitted(true);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("revoke during the pre-permit wait refuses with relay_revoked", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(
      testCaps({ perCallTimeoutMs: 2000 }),
      gw,
    );
    try {
      const pending = postUds(sock, chatBody());
      await new Promise((r) => setTimeout(r, 50));
      relay.revoke();
      const res = await pending;
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text).error.message).toBe("relay_revoked");
      expect(gw.calls.length).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("permitted request forwarded with fixed model + caps and tool names round-trip", async () => {
    const seen: { maxOutputTokens?: unknown; maxResponseBytes?: unknown } = {};
    const gw = fakeGateway({
      result: {
        text: "",
        toolCalls: [
          {
            id: "call_1",
            name: "capsule.read",
            arguments: { filePath: "/work/calc.mjs" },
          },
        ],
        stopReason: "tool_calls",
      },
      onChat: (req, options) => {
        seen.maxOutputTokens = (req as ChatRequest).maxOutputTokens;
        seen.maxResponseBytes = (
          options as { maxResponseBytes?: unknown } | undefined
        )?.maxResponseBytes;
      },
    });
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(
        sock,
        chatBody({
          max_tokens: 512,
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                description: "read a file",
                parameters: { type: "object" },
              },
            },
          ],
          tool_choice: "auto",
        }),
      );
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
      const fwd = gw.calls[0] as ChatRequest;
      // Fixed bootstrap model, never the request model.
      expect(fwd.model).toBe(FIXED_MODEL);
      // Guest "read" mapped to gateway-safe name.
      expect(fwd.tools?.[0]?.name).toBe("capsule.read");
      // maxOutputTokens = min(request 512, profile cap 1024).
      expect(fwd.maxOutputTokens).toBe(512);
      // Per-call response cap equals the gateway 1MiB ceiling (validated, never clamped).
      expect(seen.maxResponseBytes).toBe(1 * 1024 * 1024);
      // Round-trip: gateway "capsule.read" back to guest "read".
      const payload = JSON.parse(res.text);
      expect(payload.choices[0].finish_reason).toBe("tool_calls");
      const call = payload.choices[0].message.tool_calls[0];
      expect(call.function.name).toBe("read");
      expect(JSON.parse(call.function.arguments)).toEqual({
        filePath: "/work/calc.mjs",
      });
      // Usage omitted when the provider omits it.
      expect("usage" in payload).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it("accepts tool_choice required from the guest", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(sock, chatBody({ tool_choice: "required" }));
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("rejects an unsupported tool_choice value", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(sock, chatBody({ tool_choice: "none" }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).error.message).toBe(
        "unsupported_tool_choice",
      );
      expect(gw.calls.length).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("rejects caps above the gateway response ceiling", async () => {
    const gw = fakeGateway();
    expect(
      () =>
        new TrialModelRelay({
          sockPath: "/tmp/x/model.sock",
          gateway: gw,
          fixedModel: FIXED_MODEL,
          caps: testCaps({ maxResponseBytes: 1 * 1024 * 1024 + 1 }),
        }),
    ).toThrow("maxResponseBytes");
    // Ceiling itself is accepted.
    const dir = mkdtempSync(join(tmpdir(), "trial-relay-"));
    const sock = join(dir, "relay", "model.sock");
    const relay = new TrialModelRelay({
      sockPath: sock,
      gateway: gw,
      fixedModel: FIXED_MODEL,
      caps: testCaps({ maxResponseBytes: 1 * 1024 * 1024 }),
    });
    await relay.start();
    await relay.close();
  });

  it("rejects unknown tools without forwarding", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(
        sock,
        chatBody({
          tools: [
            { type: "function", function: { name: "exec", description: "x" } },
          ],
        }),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).error.message).toBe("unknown_tool");
      expect(gw.calls.length).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("call cap enforced (counted before forwarding)", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(
      testCaps({ maxModelCalls: 1 }),
      gw,
    );
    try {
      relay.setPermitted(true);
      const first = await postUds(sock, chatBody());
      expect(first.status).toBe(200);
      const second = await postUds(sock, chatBody());
      expect(second.status).toBe(429);
      expect(JSON.parse(second.text).error.message).toBe(
        "model_call_cap_exceeded",
      );
      expect(gw.calls.length).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("revoke aborts in-flight and refuses later requests", async () => {
    const gw = fakeGateway({ hang: true });
    const { relay, sock } = await startRelay(
      testCaps({ perCallTimeoutMs: 10000 }),
      gw,
    );
    try {
      relay.setPermitted(true);
      const pending = postUds(sock, chatBody());
      await new Promise((r) => setTimeout(r, 200));
      relay.revoke();
      const settled = await pending;
      expect(settled.status).toBe(403);
      expect(JSON.parse(settled.text).error.message).toBe("relay_revoked");
      expect(gw.calls.length).toBe(1);
      const after = await postUds(sock, chatBody());
      expect(after.status).toBe(403);
      expect(gw.calls.length).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("oversize request rejected before parse", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(
      testCaps({ maxRequestBytes: 16 }),
      gw,
    );
    try {
      relay.setPermitted(true);
      const res = await postUds(sock, chatBody());
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text).error.message).toBe("request_cap_exceeded");
      expect(gw.calls.length).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("stream=true yields valid SSE (single chunk + [DONE])", async () => {
    const gw = fakeGateway({
      result: { text: "done", toolCalls: [], stopReason: "stop" },
    });
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(sock, chatBody({ stream: true }));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      const frames = res.text
        .split("\n\n")
        .filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"));
      expect(frames.length).toBe(2);
      const first = JSON.parse(frames[0]?.slice("data: ".length) ?? "{}");
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.choices[0].delta.content).toBe("done");
      const last = JSON.parse(frames[1]?.slice("data: ".length) ?? "{}");
      expect(last.choices[0].finish_reason).toBe("stop");
    } finally {
      await relay.close();
    }
  });

  it("native opencode shape: long descriptions shorten + full text in labeled system message (gateway-valid)", async () => {
    // Synthetic mirror of a real captured opencode chat/completions body
    // (content redacted to synthetic text): stream + stream_options,
    // max_tokens, and native tools whose descriptions exceed the gateway
    // 1024-char bound (bash-class 4628 chars).
    const gw = fakeGateway({
      result: {
        text: "",
        toolCalls: [
          {
            id: "call_1",
            name: "capsule.read",
            arguments: { filePath: "/work/calc.mjs" },
          },
        ],
        stopReason: "tool_calls",
      },
    });
    const { logger, records } = createCollectingLogger("debug");
    const dir = mkdtempSync(join(tmpdir(), "trial-relay-"));
    const sock = join(dir, "relay", "model.sock");
    const relay = new TrialModelRelay({
      sockPath: sock,
      gateway: gw,
      fixedModel: FIXED_MODEL,
      caps: testCaps(),
      logger,
    });
    await relay.start();
    try {
      relay.setPermitted(true);
      const longDesc = `SYNTHETIC tool description ${"x".repeat(4600)}`;
      const res = await postUds(
        sock,
        chatBody({
          max_tokens: 8192,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: "synthetic system prompt" },
            { role: "user", content: "synthetic user task" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                description: longDesc,
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: "read",
                description: "synthetic short description",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          tool_choice: "auto",
        }),
      );
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
      const fwd = gw.calls[0] as ChatRequest;
      // The exact rule that rejected every guest call: gateway validation
      // must now ACCEPT the translated request (never weakened globally).
      expect(() => validateChatRequest(fwd)).not.toThrow();
      expect(fwd.tools?.length).toBe(2);
      for (const tool of fwd.tools ?? []) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeLessThanOrEqual(1024);
      }
      // Full native text preserved in a trusted labeled system message.
      const first = fwd.messages[0];
      expect(first?.role).toBe("system");
      expect(first?.content).toContain("[trial-relay tool context]");
      expect(first?.content).toContain(longDesc);
      // Guest-visible round-trip still works (stream SSE with tool_calls).
      expect(res.headers["content-type"]).toContain("text/event-stream");
      const trace = records.filter((r) => r.code === "trial.relay_request");
      expect(trace.length).toBe(1);
      expect(trace[0]?.status).toBe("forwarded");
    } finally {
      await relay.close();
    }
  });

  it("joins array text parts without separator", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(
        sock,
        chatBody({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "syn" },
                { type: "text", text: "thetic" },
              ],
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
      expect((gw.calls[0] as ChatRequest).messages[0]?.content).toBe(
        "synthetic",
      );
    } finally {
      await relay.close();
    }
  });

  it("assistant null content with tool calls plus tool reply forwards", async () => {
    const gw = fakeGateway();
    const { relay, sock } = await startRelay(testCaps(), gw);
    try {
      relay.setPermitted(true);
      const res = await postUds(
        sock,
        chatBody({
          messages: [
            { role: "user", content: "synthetic" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ filePath: "/work/calc.mjs" }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_9",
              content: "synthetic tool output",
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(gw.calls.length).toBe(1);
      const fwd = gw.calls[0] as ChatRequest;
      expect(() => validateChatRequest(fwd)).not.toThrow();
      expect(fwd.messages[1]?.content).toBe("");
      expect(fwd.messages[1]?.toolCalls?.[0]?.name).toBe("capsule.read");
    } finally {
      await relay.close();
    }
  });

  it("every rejection path logs trial.relay_request rejected with a closed-vocabulary reason", async () => {
    const gw = fakeGateway();
    const { logger, records } = createCollectingLogger("debug");
    const dir = mkdtempSync(join(tmpdir(), "trial-relay-"));
    const sock = join(dir, "relay", "model.sock");
    const relay = new TrialModelRelay({
      sockPath: sock,
      gateway: gw,
      fixedModel: FIXED_MODEL,
      caps: testCaps(),
      logger,
    });
    await relay.start();
    try {
      relay.setPermitted(true);
      const cases: Array<{ body: string; reason: string }> = [
        {
          body: chatBody({
            tools: [
              {
                type: "function",
                function: { name: "exec", description: "x" },
              },
            ],
          }),
          reason: "unknown_tool",
        },
        {
          body: chatBody({ model: "some-other-model" }),
          reason: "model_mismatch",
        },
        {
          body: chatBody({ response_format: { type: "json_object" } }),
          reason: "unsupported_option",
        },
        { body: "{not json", reason: "bad_json" },
      ];
      for (const entry of cases) {
        const res = await postUds(sock, entry.body);
        expect(res.status).toBe(400);
        expect(JSON.parse(res.text).error.message).toBe(entry.reason);
      }
      expect(gw.calls.length).toBe(0);
      const traces = records.filter((r) => r.code === "trial.relay_request");
      expect(traces.length).toBe(cases.length);
      for (let i = 0; i < cases.length; i += 1) {
        expect(traces[i]?.status).toBe("rejected");
        expect(traces[i]?.reason).toBe(cases[i]?.reason);
      }
    } finally {
      await relay.close();
    }
  });

  it("close aborts in-flight gateway calls and never hangs (finding 2)", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const gw = fakeGateway({
      hang: true,
      signalSeen: { current: null },
      onChat: (_req, options) => {
        seen.signal =
          (options as { signal?: AbortSignal } | undefined)?.signal ?? null;
      },
    });
    const { relay, sock } = await startRelay(
      testCaps({ perCallTimeoutMs: 10000 }),
      gw,
    );
    try {
      relay.setPermitted(true);
      const pending = postUds(sock, chatBody());
      pending.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      expect(gw.calls.length).toBe(1);
      const closed = await Promise.race([
        relay.close().then(() => "closed" as const),
        new Promise((r) => setTimeout(() => r("timeout" as const), 3000)),
      ]);
      expect(closed).toBe("closed");
      // In-flight controller was aborted so the hanging gateway call ended.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.signal?.aborted).toBe(true);
      await pending.catch(() => undefined);
    } finally {
      await relay.close().catch(() => undefined);
    }
  });
});
