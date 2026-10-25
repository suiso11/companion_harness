// Production AGORA transport. The host is fixed; callers can only select one
// of the known API paths. Public reads reuse the hardened page fetcher (DNS
// pinning, redirect rejection, bounded body). Writes use the SAME fixed host
// with the same pinning/redirect/bounds rules.

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  AGORA_BASE_URL,
  AGORA_HELLO_PATH,
  AGORA_MAX_RESPONSE_BYTES_DEFAULT,
  AGORA_THREAD_PAGE_PREFIX,
  AGORA_TIMEOUT_MS_DEFAULT,
  type AgoraTransport,
  type AgoraTransportGetResult,
  type AgoraTransportPostResult,
} from "./agora.js";
import { ToolError } from "./broker.js";
import {
  assertPublicHttpUrl,
  createPinnedLookup,
  fetchPublicPage,
  isPublicIpAddress,
  unbracketHostname,
} from "./public_web.js";

const REGISTER_PATH = "/api/register";
const THREADS_PATH = "/api/threads";

function isKnownGetPath(path: string): boolean {
  if (path === AGORA_HELLO_PATH) return true;
  if (!path.startsWith(AGORA_THREAD_PAGE_PREFIX)) return false;
  const id = path.slice(AGORA_THREAD_PAGE_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function isKnownPostPath(path: string): boolean {
  if (path === REGISTER_PATH || path === THREADS_PATH) return true;
  return /^\/api\/threads\/[A-Za-z0-9_-]{1,128}\/posts$/.test(path);
}

async function resolvePublicAddress(host: string): Promise<string> {
  if (isIP(host) !== 0) {
    if (!isPublicIpAddress(host)) throw new ToolError("tool_denied");
    return host;
  }
  const resolved = await dnsLookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new ToolError("execution_failed");
  for (const entry of resolved) {
    if (!isPublicIpAddress(unbracketHostname(entry.address))) {
      throw new ToolError("tool_denied");
    }
  }
  return unbracketHostname(resolved[0]?.address ?? "");
}

export interface AgoraHttpTransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export function createAgoraHttpTransport(
  options: AgoraHttpTransportOptions = {},
): AgoraTransport {
  const timeoutMs = options.timeoutMs ?? AGORA_TIMEOUT_MS_DEFAULT;
  const maxBytes = options.maxResponseBytes ?? AGORA_MAX_RESPONSE_BYTES_DEFAULT;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 8 * 1024 * 1024
  ) {
    throw new ToolError("invalid_input");
  }

  async function get(
    path: string,
    getOptions: { signal?: AbortSignal } = {},
  ): Promise<AgoraTransportGetResult> {
    if (!isKnownGetPath(path)) throw new ToolError("invalid_input");
    const url = `${AGORA_BASE_URL}${path}`;
    assertPublicHttpUrl(url);
    const result = await fetchPublicPage(url, {
      maxBytes,
      timeoutMs,
      ...(getOptions.signal !== undefined ? { signal: getOptions.signal } : {}),
    });
    return {
      status: result.status,
      text: result.text,
      contentType: result.contentType,
    };
  }

  async function post(
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
    postOptions: { signal?: AbortSignal } = {},
  ): Promise<AgoraTransportPostResult> {
    if (!isKnownPostPath(path)) throw new ToolError("invalid_input");
    const urlText = `${AGORA_BASE_URL}${path}`;
    const url = assertPublicHttpUrl(urlText);
    if (url.hostname.toLowerCase() !== new URL(AGORA_BASE_URL).hostname) {
      throw new ToolError("tool_denied");
    }
    if (postOptions.signal?.aborted) {
      throw new ToolError("execution_cancelled");
    }
    const host = unbracketHostname(url.hostname).toLowerCase();
    const payload = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payload, "utf8");

    return await new Promise<AgoraTransportPostResult>((resolve, reject) => {
      let settled = false;
      let responseBytes = 0;
      let req: ReturnType<typeof httpsRequest> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunks: Buffer[] = [];
      const finish = (
        error: Error | null,
        value?: AgoraTransportPostResult,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        postOptions.signal?.removeEventListener("abort", onAbort);
        if (error !== null) {
          try {
            req?.destroy();
          } catch {
            // Best effort.
          }
          reject(error);
          return;
        }
        if (value !== undefined) resolve(value);
      };
      const onAbort = (): void => finish(new ToolError("execution_cancelled"));

      // Deadline and cancellation start BEFORE DNS so a stalled lookup cannot
      // outlive the caller's budget or keep a cancelled send alive.
      timer = setTimeout(
        () => finish(new ToolError("execution_timeout")),
        timeoutMs,
      );
      postOptions.signal?.addEventListener("abort", onAbort, { once: true });

      resolvePublicAddress(host).then(
        (address) => {
          // A late DNS answer must never lead to a send after deadline or
          // cancellation settlement.
          if (settled) return;
          if (postOptions.signal?.aborted) {
            finish(new ToolError("execution_cancelled"));
            return;
          }
          req = httpsRequest(
            {
              protocol: "https:",
              hostname: host,
              path: `${url.pathname}${url.search}`,
              method: "POST",
              headers: {
                host,
                "content-type": "application/json",
                accept: "application/json",
                "content-length": String(payloadBytes),
                ...headers,
              },
              lookup: createPinnedLookup(address),
              servername: isIP(host) === 0 ? host : undefined,
            },
            (response) => {
              const status = response.statusCode ?? 0;
              // No redirect following. The service classifies 3xx as
              // ambiguous.
              if (status >= 300 && status < 400) {
                response.destroy();
                finish(null, { status, text: "" });
                return;
              }
              const declared = Number(response.headers["content-length"]);
              if (Number.isFinite(declared) && declared > maxBytes) {
                response.destroy();
                finish(new ToolError("output_too_large"));
                return;
              }
              response.on("data", (chunk: Buffer) => {
                if (settled) return;
                responseBytes += chunk.byteLength;
                if (responseBytes > maxBytes) {
                  response.destroy();
                  finish(new ToolError("output_too_large"));
                  return;
                }
                chunks.push(chunk);
              });
              response.on("error", () =>
                finish(new ToolError("execution_failed")),
              );
              response.on("end", () => {
                if (settled) return;
                let text: string;
                try {
                  text = new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  );
                } catch {
                  finish(new ToolError("output_invalid"));
                  return;
                }
                finish(null, { status, text });
              });
            },
          );
          req.on("error", () => finish(new ToolError("execution_failed")));
          req.end(payload);
        },
        (error: unknown) => {
          // Resolver failures stay safe/fixed; unknown failures are generic.
          finish(
            error instanceof ToolError
              ? error
              : new ToolError("execution_failed"),
          );
        },
      );
    });
  }

  return { get, post };
}
