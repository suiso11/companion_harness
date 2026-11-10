export interface RemoteChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export interface RemoteChatRequest {
  readonly messages: readonly RemoteChatMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}
export interface RemoteChatResult {
  readonly text: string;
  readonly usage: { promptTokens: number; completionTokens: number } | null;
}
export type RemoteProviderId = "openai" | "deepseek" | "opencode";

/**
 * Fixed endpoints: the caller never supplies a URL, so there is no SSRF
 * surface. OpenCode Zen exposes an OpenAI-compatible gateway under a path
 * prefix instead of `/v1`.
 */
export const REMOTE_PROVIDER_ENDPOINTS: Readonly<
  Record<RemoteProviderId, string>
> = {
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  opencode: "https://opencode.ai/inference/openai/v1/chat/completions",
};

export type RemoteProviderErrorCode =
  | "invalid_input"
  | "request_failed"
  | "timeout"
  | "response_invalid"
  | "response_too_large"
  | "unauthorized";

const MESSAGES: Record<RemoteProviderErrorCode, string> = {
  invalid_input: "Invalid remote provider input",
  request_failed: "Remote provider request failed",
  timeout: "Remote provider request timed out",
  response_invalid: "Remote provider response invalid",
  response_too_large: "Remote provider response too large",
  unauthorized: "Remote provider rejected the API key",
};

export class RemoteProviderError extends Error {
  readonly code: RemoteProviderErrorCode;
  constructor(code: RemoteProviderErrorCode) {
    super(MESSAGES[code]);
    this.name = "RemoteProviderError";
    this.code = code;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,256}$/;
const KEY_RE = /^[\x21-\x7e]{1,4096}$/;
const ROLES = new Set(["system", "user", "assistant"]);

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Reads at most MAX_BODY_BYTES; content-length is a cheap pre-check, the reader enforces the cap. */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new RemoteProviderError("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new RemoteProviderError("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function parseResult(raw: string): RemoteChatResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RemoteProviderError("response_invalid");
  }
  const body = json as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string")
    throw new RemoteProviderError("response_invalid");
  const prompt = nonNegInt(body?.usage?.prompt_tokens);
  const completion = nonNegInt(body?.usage?.completion_tokens);
  return {
    text,
    usage:
      prompt !== null && completion !== null
        ? { promptTokens: prompt, completionTokens: completion }
        : null,
  };
}

export function createRemoteGateway(options: {
  provider: RemoteProviderId;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): {
  readonly provider: RemoteProviderId;
  readonly model: string;
  chat(request: RemoteChatRequest): Promise<RemoteChatResult>;
} {
  const { provider, model, apiKey } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (
    !Object.hasOwn(REMOTE_PROVIDER_ENDPOINTS, provider) ||
    typeof model !== "string" ||
    !MODEL_RE.test(model) ||
    typeof apiKey !== "string" ||
    !KEY_RE.test(apiKey) ||
    !inRange(timeoutMs, 1, 300_000)
  ) {
    throw new RemoteProviderError("invalid_input");
  }
  const url = REMOTE_PROVIDER_ENDPOINTS[provider];

  return {
    provider,
    model,
    async chat(request) {
      const maxTokens = request.maxOutputTokens ?? 1024;
      const temperature = request.temperature;
      if (
        !Array.isArray(request.messages) ||
        request.messages.length === 0 ||
        !request.messages.every(
          (m) =>
            m &&
            ROLES.has(m.role) &&
            typeof m.content === "string" &&
            m.content.length > 0,
        ) ||
        !Number.isInteger(maxTokens) ||
        !inRange(maxTokens, 1, 8192) ||
        (temperature !== undefined && !inRange(temperature, 0, 2))
      ) {
        throw new RemoteProviderError("invalid_input");
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort();
      if (request.signal?.aborted) controller.abort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (controller.signal.aborted) throw new RemoteProviderError("timeout");
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            // OpenAI reasoning models reject `max_tokens`; current chat models
            // accept `max_completion_tokens`. DeepSeek still uses `max_tokens`.
            [provider === "openai" ? "max_completion_tokens" : "max_tokens"]:
              maxTokens,
            ...(temperature === undefined ? {} : { temperature }),
            stream: false,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteProviderError("unauthorized");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteProviderError("request_failed");
        }
        return parseResult(await readCapped(response));
      } catch (error) {
        if (error instanceof RemoteProviderError) throw error;
        if (controller.signal.aborted) {
          // Caller-initiated aborts also surface as timeout: one fixed code for "did not finish".
          throw new RemoteProviderError(
            timedOut || request.signal?.aborted ? "timeout" : "request_failed",
          );
        }
        throw new RemoteProviderError("request_failed");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
