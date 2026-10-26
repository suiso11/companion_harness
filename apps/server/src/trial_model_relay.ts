// Per-execution trial model relay (host side of the Own-pi wholejob bridge).
//
// The Own-pi bridge's guest uses this relay as its model endpoint (bridge
// config `modelSockHostPath`). Protocol notes (host side implemented here):
//
// Guest relay (capsule-wholejob-guest.mjs, in-guest 127.0.0.1 relay -> host
// UDS; anchors below):
//   - Listens on an ephemeral 127.0.0.1 port (`startRelay`, guest line ~503).
//   - Forwards ONLY POST /v1/chat/completions over the supplied UDS pathname
//     (`forwardToUds`, guest line ~471: socketPath GUEST_SOCK_PATH,
//     path RELAY_PATH, method POST, content-type application/json).
//   - Request cap 16MiB (`MAX_RELAY_REQUEST_BYTES`, guest line ~67) via
//     `readBounded` (guest line ~457): over-cap destroys the request and
//     answers fixed 413 `request_cap_exceeded` (`fixedJson`, guest line ~453).
//   - Response cap 8MiB (`MAX_RELAY_RESPONSE_BYTES`, guest line ~68):
//     over-cap destroys the upstream and answers fixed 502
//     `response_cap_exceeded`; upstream errors map to fixed 502
//     `upstream_error` / `upstream_unavailable`.
//   - Any other method/path answers fixed 404 `not_found`.
//   - The guest passes the raw request body through byte-identical
//     (`upstream.end(body)`) and streams the upstream response back with
//     content-type application/json, preserving status.
// Synthetic responder (.capsmoke-wj/responder.mjs, prior smoke fixture):
//   - Accepts ONLY POST /v1/chat/completions (else fixed 404 `not_found`).
//   - Parses JSON (failure -> fixed 400 `bad_json`).
//   - `stream === true` answers `text/event-stream` with a single buffered
//     chunk plus a terminal chunk plus `data: [DONE]` (`ssePayload`);
//     otherwise answers OpenAI chat.completion JSON
//     (`completionText` / `completionTools`).
//   - Tool calls use PLAIN guest tool names (`read`/`edit`/`bash`) with
//     stringified-JSON arguments; title turns (no tools array) answer text.
//   - This host relay mirrors that contract: plain guest names on the UDS
//     wire, gateway-safe `capsule.<name>` names toward ModelGateway.
//
// Host relay guarantees in this module:
//   - Socket file created in a 0700 private dir, chmod 0600, unlinked only
//     by close for a socket this instance actually bound. Bind never removes
//     an existing path: EADDRINUSE (including a stale file with no listener)
//     fails closed and the operator must remove it.
//   - Gate: `setPermitted(true)` is called by the runner only after the
//     kernel permit; before that, or after `revoke()` (Stop/cancel/FG
//     preempt), every request gets a fixed error response and is NOT
//     forwarded. Requests in flight are aborted on revoke (AbortController
//     -> gateway signal) and on per-call timeout.
//   - Translation OpenAI chat/completions JSON <-> ModelGateway.chat with a
//     fixed bootstrap model name (never taken from the request).
//   - Required caps are constructor args with no defaults.

import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import type {
  ChatMessage,
  ChatResult,
  ModelGateway,
  ToolDefinition,
} from "@companion/model-local";
import {
  MAX_MESSAGE_CONTENT_LENGTH as GATEWAY_MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MESSAGES_PER_REQUEST as GATEWAY_MAX_MESSAGES_PER_REQUEST,
  MAX_RESPONSE_BYTES as GATEWAY_MAX_RESPONSE_BYTES,
} from "@companion/model-local";
import type { ServerLogger } from "./logger.js";

/**
 * Guest-native tool names spoken on the UDS wire (plain, no namespace).
 * The installed pi-orch parent advertises the delegation tools alongside the
 * fixed child tools; the relay is a transport, not a second authority (the
 * sealed bridge still validates containment/scopes/checks).
 *
 * `find` and `ls` are the installed Pi backend's exact read-only child verbs
 * (`piToolList` -> read,grep,find,ls); the installed OMP adapter maps its
 * `glob` to `find` for native children. They are explicit, closed-vocabulary
 * entries only: any other unlisted verb still fails closed as `unknown_tool`.
 */
export const GUEST_TOOL_NAMES = [
  "bash",
  "edit",
  "find",
  "glob",
  "grep",
  "ls",
  "read",
  "write",
  "task",
  "wait",
  "opencode_task",
  "opencode_spawn",
  "opencode_wait",
  "opencode_tools",
] as const;

export type GuestToolName = (typeof GUEST_TOOL_NAMES)[number];

/** Gateway-safe image of a guest tool name (satisfies NATIVE_TOOL_NAME_PATTERN). */
export function toGatewayToolName(guest: GuestToolName): string {
  return `capsule.${guest}`;
}

/** Inverse image; null when the gateway name is not a known tool. */
export function toGuestToolName(gateway: string): GuestToolName | null {
  if (!gateway.startsWith("capsule.")) return null;
  const rest = gateway.slice("capsule.".length);
  for (const known of GUEST_TOOL_NAMES) {
    if (rest === known) return known;
  }
  return null;
}

function isGuestToolName(value: unknown): value is GuestToolName {
  return (
    typeof value === "string" &&
    (GUEST_TOOL_NAMES as readonly string[]).includes(value)
  );
}

/** Canonical cap ordering: both inputs validated, each field is the minimum.
 * Callers use this to apply host static ceilings WITHOUT ever widening a
 * narrower execution policy. */
export function narrowTrialModelRelayCaps(
  staticCaps: TrialModelRelayCaps,
  requestedCaps: TrialModelRelayCaps,
): TrialModelRelayCaps {
  validateTrialModelRelayCaps(staticCaps);
  validateTrialModelRelayCaps(requestedCaps);
  return Object.freeze({
    maxRequestBytes: Math.min(
      staticCaps.maxRequestBytes,
      requestedCaps.maxRequestBytes,
    ),
    maxModelCalls: Math.min(
      staticCaps.maxModelCalls,
      requestedCaps.maxModelCalls,
    ),
    maxOutputTokens: Math.min(
      staticCaps.maxOutputTokens,
      requestedCaps.maxOutputTokens,
    ),
    maxResponseBytes: Math.min(
      staticCaps.maxResponseBytes,
      requestedCaps.maxResponseBytes,
    ),
    perCallTimeoutMs: Math.min(
      staticCaps.perCallTimeoutMs,
      requestedCaps.perCallTimeoutMs,
    ),
    maxConcurrent: Math.min(
      staticCaps.maxConcurrent,
      requestedCaps.maxConcurrent,
    ),
  });
}

/** Required caps: every field must be supplied; invalid values throw. */
export interface TrialModelRelayCaps {
  /** Max UDS request body bytes (guest uses 16MiB; enforced before parse). */
  maxRequestBytes: number;
  /** Max forwarded model calls per relay lifetime (counted before forward). */
  maxModelCalls: number;
  /** Profile output-token cap: effective maxOutputTokens = min(request, cap). */
  maxOutputTokens: number;
  /** Per-call gateway response byte cap + serialized-response ceiling. */
  maxResponseBytes: number;
  /** Per-call gateway timeout in ms (aborts the gateway signal). */
  perCallTimeoutMs: number;
  /** Max concurrent in-flight model calls; excess is rejected. */
  maxConcurrent: number;
}

export interface TrialModelRelayOptions {
  /** UDS pathname to bind (parent dir becomes the 0700 private dir). */
  sockPath: string;
  /** ModelGateway to forward permitted requests to (fake in tests/smoke). */
  gateway: ModelGateway;
  /** Fixed bootstrap model name sent to the gateway (never from request). */
  fixedModel: string;
  caps: TrialModelRelayCaps;
  /** Optional redacted request trace (trial.relay_request); omitted in tests. */
  logger?: ServerLogger | undefined;
}

const RELAY_PATH = "/v1/chat/completions";
/** Request models accepted without mismatch (fixed alias semantics). */
const MODEL_ALIASES = new Set([
  "companion/companion-current",
  "companion-current",
]);

/** Fixed short-tool-description budget (gateway bound is 1024). */
const GATEWAY_TOOL_DESCRIPTION_LIMIT = 1024;
/** Short definition budget kept well under the gateway bound. */
const RELAY_SHORT_DESCRIPTION_LIMIT = 800;
/** Trusted labeled prefix for the relay-generated tool-context message. */
export const RELAY_TOOL_CONTEXT_PREFIX =
  "[trial-relay tool context] Full native tool descriptions " +
  "(informational only; the short tool definitions remain authoritative " +
  "and every tool call is still validated):";

/**
 * Closed-vocabulary reason codes for the redacted per-request trace.
 * Every rejection path reports one of these via `trial.relay_request`
 * (status 'rejected' plus the reason); the logger allowlist enforces the
 * closed vocabulary. Forwarded calls carry no reason.
 */
export type RelayRequestReason =
  | "not_found"
  | "bad_request"
  | "request_cap_exceeded"
  | "relay_revoked"
  | "relay_not_permitted"
  | "relay_busy"
  | "model_call_cap_exceeded"
  | "bad_json"
  | "invalid_request"
  | "model_mismatch"
  | "unsupported_tool_choice"
  | "unsupported_option"
  | "unknown_tool"
  | "unknown_tool_call_id"
  | "model_error"
  | "model_timeout"
  | "invalid_response"
  | "response_cap_exceeded"
  | "request_failed"
  | "transport_error"
  | "tool_call_invalid"
  | "unsupported_capability";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixedErrorBody(code: string): string {
  return JSON.stringify({ error: { message: code, type: code } });
}

export function validateTrialModelRelayCaps(caps: TrialModelRelayCaps): void {
  if (!isRecord(caps as unknown as Record<string, unknown>)) {
    throw new Error("trial_model_relay: caps are required");
  }
  const ints: Array<[string, number]> = [
    ["maxRequestBytes", caps.maxRequestBytes],
    ["maxModelCalls", caps.maxModelCalls],
    ["maxOutputTokens", caps.maxOutputTokens],
    ["maxResponseBytes", caps.maxResponseBytes],
    ["perCallTimeoutMs", caps.perCallTimeoutMs],
    ["maxConcurrent", caps.maxConcurrent],
  ];
  for (const [name, value] of ints) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error(`trial_model_relay: cap ${name} must be an integer >= 1`);
    }
  }
  if (caps.maxResponseBytes > GATEWAY_MAX_RESPONSE_BYTES) {
    throw new Error(
      "trial_model_relay: cap maxResponseBytes exceeds the gateway ceiling",
    );
  }
}

interface TranslatedCall {
  gatewayMessages: ChatMessage[];
  gatewayTools: ToolDefinition[] | undefined;
  maxOutputTokens: number;
  stream: boolean;
}

/**
 * Per-execution Unix-domain-socket OpenAI chat/completions server.
 * Exactly one instance per trial execution; never shared across trials.
 */
export class TrialModelRelay {
  private readonly sockPath: string;
  private readonly gateway: ModelGateway;
  private readonly fixedModel: string;
  private readonly caps: TrialModelRelayCaps;
  private readonly logger: ServerLogger | null;
  private server: Server | null = null;
  private permitted = false;
  private revokedObserved = false;
  private readonly permitWaiters = new Set<{
    resolve: (v: "permitted" | "revoked") => void;
  }>();
  private forwardedCalls = 0;
  private inFlight = 0;
  private readonly liveControllers = new Set<AbortController>();
  private readonly openSockets = new Set<Socket>();
  private started = false;
  /** True only after THIS instance successfully bound the socket path. */
  private bound = false;

  constructor(options: TrialModelRelayOptions) {
    if (!isRecord(options as unknown as Record<string, unknown>)) {
      throw new Error("trial_model_relay: options are required");
    }
    if (typeof options.sockPath !== "string" || options.sockPath.length === 0) {
      throw new Error("trial_model_relay: sockPath must be a non-empty string");
    }
    if (
      typeof options.gateway !== "object" ||
      options.gateway === null ||
      typeof (options.gateway as ModelGateway).chat !== "function"
    ) {
      throw new Error("trial_model_relay: gateway with chat() is required");
    }
    if (
      typeof options.fixedModel !== "string" ||
      options.fixedModel.length === 0
    ) {
      throw new Error("trial_model_relay: fixedModel must be non-empty");
    }
    validateTrialModelRelayCaps(options.caps);
    this.sockPath = options.sockPath;
    this.gateway = options.gateway;
    this.fixedModel = options.fixedModel;
    this.caps = { ...options.caps };
    this.logger = options.logger ?? null;
  }

  get path(): string {
    return this.sockPath;
  }

  get callCount(): number {
    return this.forwardedCalls;
  }

  /** Runner calls with true only after the kernel permit. */
  setPermitted(permitted: boolean): void {
    this.permitted = permitted === true;
    if (this.permitted) {
      this.revokedObserved = false;
      this.notifyPermitWaiters("permitted");
    } else {
      this.revokedObserved = true;
      this.notifyPermitWaiters("revoked");
    }
  }

  /**
   * Stop/cancel/FG-preempt gate: closes the permit and aborts every
   * in-flight gateway call via its AbortController.
   */
  revoke(): void {
    this.permitted = false;
    this.revokedObserved = true;
    this.notifyPermitWaiters("revoked");
    for (const controller of this.liveControllers) {
      try {
        controller.abort();
      } catch {
        // Best effort: abort must never throw out of revoke.
      }
    }
  }

  private notifyPermitWaiters(outcome: "permitted" | "revoked"): void {
    if (this.permitWaiters.size === 0) return;
    const waiters = [...this.permitWaiters];
    this.permitWaiters.clear();
    for (const waiter of waiters) {
      try {
        waiter.resolve(outcome);
      } catch {
        // Best effort: waiter resolution never throws out of the gate.
      }
    }
  }

  /**
   * Redacted per-request trace: fixed status only (forwarded |
   * waited_then_forwarded | not_permitted | revoked | rejected) plus a
   * closed-vocabulary reason on every non-forwarded path and the handler
   * latency in ms. No bodies, names, or paths.
   */
  private logRelayRequest(
    status:
      | "forwarded"
      | "waited_then_forwarded"
      | "not_permitted"
      | "revoked"
      | "rejected",
    startMs: number,
    reason?: RelayRequestReason,
    httpStatus?: number,
  ): void {
    if (this.logger === null) return;
    this.logger.info("trial.relay_request", {
      status,
      durationMs: Math.max(0, Date.now() - startMs),
      ...(reason === undefined ? {} : { reason }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  }

  /**
   * Pre-permit guest calls WAIT (bounded by perCallTimeoutMs) for the
   * runner's permit instead of an immediate 403: the guest may call the
   * model before the Root-side permit lands. Revoke/close resolves to
   * 'revoked'; the deadline resolves to 'timeout'.
   */
  private waitForPermit(): Promise<"permitted" | "revoked" | "timeout"> {
    if (this.permitted) return Promise.resolve("permitted");
    if (this.revokedObserved) return Promise.resolve("revoked");
    return new Promise((resolve) => {
      const entry = {
        resolve: (v: "permitted" | "revoked") => {
          clearTimeout(timer);
          this.permitWaiters.delete(entry);
          resolve(v);
        },
      };
      const timer = setTimeout(() => {
        this.permitWaiters.delete(entry);
        resolve("timeout");
      }, this.caps.perCallTimeoutMs);
      this.permitWaiters.add(entry);
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("trial_model_relay: already started");
    const dir = dirname(this.sockPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Never unlink an existing path before bind: the runner maps EADDRINUSE
    // to launch-failed. A stale socket file with no listener is also refused
    // (the operator must remove it); ownership is proven only by OUR bind.
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server.on("connection", (sock: Socket) => {
      this.openSockets.add(sock);
      sock.on("close", () => {
        this.openSockets.delete(sock);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        if (this.server === null) {
          reject(new Error("trial_model_relay: server missing"));
          return;
        }
        this.server.once("error", reject);
        this.server.listen(this.sockPath, () => {
          this.server?.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      // This instance never owned the path: drop the server and do NOT
      // unlink anything on a later close().
      this.server = null;
      throw error;
    }
    this.bound = true;
    chmodSync(this.sockPath, 0o600);
    this.started = true;
  }

  async close(): Promise<void> {
    const server = this.server;
    const ownedSocket = this.bound;
    this.server = null;
    this.bound = false;
    this.permitted = false;
    this.revokedObserved = true;
    this.notifyPermitWaiters("revoked");
    // Abort every in-flight gateway call so close never waits on them.
    for (const controller of [...this.liveControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort: abort must never throw out of close.
      }
    }
    if (server !== null) {
      // Destroy open sockets (incl. keep-alive) before server.close so the
      // close callback fires promptly instead of hanging on idle conns.
      try {
        (
          server as unknown as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
      } catch {
        // Best effort: older typings may lack closeAllConnections.
      }
      for (const sock of [...this.openSockets]) {
        try {
          sock.destroy();
        } catch {
          // Best effort.
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.openSockets.clear();
    // Only remove the path this instance actually bound. A failed/foreign
    // bind or a reused stale path must never be deleted by close().
    if (ownedSocket) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        // Already gone: close is idempotent.
      }
    }
    this.started = false;
  }

  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const startMs = Date.now();
    let waitedForPermit = false;
    if (req.method !== "POST" || (req.url ?? "") !== RELAY_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(fixedErrorBody("not_found"));
      this.logRelayRequest("rejected", startMs, "not_found");
      return;
    }
    // Bounded read BEFORE parse (guest `readBounded` parity): over-cap is
    // rejected without JSON parsing and without forwarding.
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    try {
      for await (const chunk of req) {
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        total += buf.length;
        if (total > this.caps.maxRequestBytes) {
          overCap = true;
          break;
        }
        chunks.push(buf);
      }
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(fixedErrorBody("bad_request"));
      this.logRelayRequest("rejected", startMs, "bad_request");
      return;
    }
    if (overCap) {
      try {
        req.destroy();
      } catch {
        // Best effort drain-stop.
      }
      res.writeHead(413, { "content-type": "application/json" });
      res.end(fixedErrorBody("request_cap_exceeded"));
      this.logRelayRequest("rejected", startMs, "request_cap_exceeded");
      return;
    }
    // Gate: pre-permit requests WAIT (bounded) for the runner's permit
    // instead of an immediate 403; revoke or the deadline ends the wait
    // with a fixed error and no forward.
    if (!this.permitted) {
      waitedForPermit = true;
      const waited = await this.waitForPermit();
      if (waited === "revoked" || this.revokedObserved) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(fixedErrorBody("relay_revoked"));
        this.logRelayRequest("revoked", startMs, "relay_revoked");
        return;
      }
      if (!this.permitted) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(fixedErrorBody("relay_not_permitted"));
        this.logRelayRequest("not_permitted", startMs, "relay_not_permitted");
        return;
      }
    }
    if (this.inFlight >= this.caps.maxConcurrent) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(fixedErrorBody("relay_busy"));
      this.logRelayRequest("rejected", startMs, "relay_busy");
      return;
    }
    // Call cap counted BEFORE forwarding.
    if (this.forwardedCalls >= this.caps.maxModelCalls) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(fixedErrorBody("model_call_cap_exceeded"));
      this.logRelayRequest("rejected", startMs, "model_call_cap_exceeded");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(fixedErrorBody("bad_json"));
      this.logRelayRequest("rejected", startMs, "bad_json");
      return;
    }
    let translated: TranslatedCall;
    try {
      translated = this.translateRequest(body);
    } catch (error) {
      const code =
        error instanceof TranslationError ? error.code : "invalid_request";
      res.writeHead(400, { "content-type": "application/json" });
      res.end(fixedErrorBody(code));
      this.logRelayRequest("rejected", startMs, toRelayReason(code));
      return;
    }
    this.forwardedCalls += 1;
    this.inFlight += 1;
    const controller = new AbortController();
    this.liveControllers.add(controller);
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // Best effort timeout abort.
      }
    }, this.caps.perCallTimeoutMs);
    let result: ChatResult;
    try {
      // The gateway enforces its own 1MiB per-call response ceiling, which
      // matches the relay cap ceiling above: caps are validated, never
      // silently clamped, so pass the cap through directly.
      result = await this.gateway.chat(
        {
          model: this.fixedModel,
          messages: translated.gatewayMessages,
          ...(translated.gatewayTools === undefined
            ? {}
            : { tools: translated.gatewayTools }),
          maxOutputTokens: translated.maxOutputTokens,
        },
        {
          signal: controller.signal,
          maxResponseBytes: this.caps.maxResponseBytes,
        },
      );
    } catch (error) {
      if (controller.signal.aborted && !this.permitted) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(fixedErrorBody("relay_revoked"));
        this.logRelayRequest("revoked", startMs, "relay_revoked");
        return;
      }
      if (controller.signal.aborted) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(fixedErrorBody("model_timeout"));
        this.logRelayRequest("rejected", startMs, "model_timeout");
        return;
      }
      const code = gatewayErrorCode(error);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(fixedErrorBody(code));
      this.logRelayRequest(
        "rejected",
        startMs,
        toRelayReason(code),
        gatewayErrorHttpStatus(error),
      );
      return;
    } finally {
      clearTimeout(timer);
      this.liveControllers.delete(controller);
      this.inFlight -= 1;
    }
    let payload: {
      status: number;
      headers: Record<string, string>;
      body: string;
    };
    try {
      payload = this.renderResult(result, translated.stream);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(fixedErrorBody("invalid_response"));
      this.logRelayRequest("rejected", startMs, "invalid_response");
      return;
    }
    if (Buffer.byteLength(payload.body, "utf8") > this.caps.maxResponseBytes) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(fixedErrorBody("response_cap_exceeded"));
      this.logRelayRequest("rejected", startMs, "response_cap_exceeded");
      return;
    }
    res.writeHead(payload.status, payload.headers);
    res.end(payload.body);
    this.logRelayRequest(
      waitedForPermit ? "waited_then_forwarded" : "forwarded",
      startMs,
    );
  }

  private translateRequest(body: unknown): TranslatedCall {
    if (!isRecord(body)) throw new TranslationError("invalid_request");
    // Fixed bootstrap model: never taken from the request. A present model
    // must be the fixed name or the known alias; anything else mismatches.
    if (body.model !== undefined) {
      const asked = body.model;
      if (
        typeof asked !== "string" ||
        (asked !== this.fixedModel && !MODEL_ALIASES.has(asked))
      ) {
        throw new TranslationError("model_mismatch");
      }
    }
    // tool_choice "auto" or "required" when present; the gateway owns the
    // effective policy (its default is `required` for tool-bearing calls).
    if (
      body.tool_choice !== undefined &&
      body.tool_choice !== null &&
      body.tool_choice !== "auto" &&
      body.tool_choice !== "required"
    ) {
      throw new TranslationError("unsupported_tool_choice");
    }
    // stream must be boolean when present.
    let stream = false;
    if (body.stream !== undefined && body.stream !== null) {
      if (typeof body.stream !== "boolean") {
        throw new TranslationError("invalid_request");
      }
      stream = body.stream;
    }
    // Native sampling/passthrough options the fixed gateway profile does not
    // consume: validated for shape when present, otherwise ignored. Anything
    // that would change the output contract is rejected below instead.
    if (body.stream_options !== undefined && body.stream_options !== null) {
      if (!isRecord(body.stream_options)) {
        throw new TranslationError("invalid_request");
      }
    }
    for (const key of [
      "temperature",
      "top_p",
      "presence_penalty",
      "frequency_penalty",
      "parallel_tool_calls",
      "seed",
      "user",
    ]) {
      if (body[key] !== undefined && body[key] !== null) {
        if (
          typeof body[key] !== "number" &&
          typeof body[key] !== "string" &&
          typeof body[key] !== "boolean"
        ) {
          throw new TranslationError("invalid_request");
        }
      }
    }
    // Options that would change the output contract if silently dropped:
    // the relay has no gateway surface for them, so reject (never ignore).
    for (const key of [
      "response_format",
      "reasoning",
      "reasoning_effort",
      "prediction",
      "audio",
      "modalities",
    ]) {
      if (body[key] !== undefined && body[key] !== null) {
        throw new TranslationError("unsupported_option");
      }
    }
    // max_tokens narrows the profile cap; effective = min(request, cap).
    let maxOutputTokens = this.caps.maxOutputTokens;
    if (body.max_tokens !== undefined) {
      const asked = body.max_tokens;
      if (
        typeof asked !== "number" ||
        !Number.isSafeInteger(asked) ||
        asked < 1
      ) {
        throw new TranslationError("invalid_request");
      }
      maxOutputTokens = Math.min(asked, this.caps.maxOutputTokens);
    }
    const rawMessages = body.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new TranslationError("invalid_request");
    }
    // Map assistant tool_call ids -> gateway tool names for tool replies.
    const idToGateway = new Map<string, string>();
    for (const entry of rawMessages) {
      if (!isRecord(entry) || !Array.isArray(entry.tool_calls)) continue;
      for (const call of entry.tool_calls as unknown[]) {
        if (!isRecord(call)) continue;
        const fn = call.function;
        if (!isRecord(fn)) continue;
        const name = fn.name;
        const id = call.id;
        if (typeof id === "string" && isGuestToolName(name)) {
          idToGateway.set(id, toGatewayToolName(name));
        }
      }
    }
    let gatewayMessages: ChatMessage[] = rawMessages.map((entry) =>
      this.translateMessage(entry, idToGateway),
    );
    let gatewayTools: ToolDefinition[] | undefined;
    let toolContext: string | undefined;
    if (body.tools !== undefined && body.tools !== null) {
      const rawTools = body.tools;
      if (!Array.isArray(rawTools))
        throw new TranslationError("invalid_request");
      const translatedTools = rawTools.map((entry) =>
        this.translateTool(entry),
      );
      const seen = new Set<string>();
      for (const tool of translatedTools) {
        if (seen.has(tool.name)) throw new TranslationError("invalid_request");
        seen.add(tool.name);
      }
      gatewayTools = translatedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.parameters === undefined
          ? {}
          : { parameters: tool.parameters }),
      }));
      // The gateway enforces a 1024-char tool-description bound that native
      // opencode tool descriptions exceed (~4628 chars): send short
      // gateway-valid definitions and preserve the FULL native descriptions
      // in one trusted labeled system message at the front of the history.
      // Model-local validation is never weakened; the short definitions
      // stay authoritative and every tool call is still validated.
      const fullDescriptions = translatedTools.map((tool) => ({
        name: tool.name,
        description: tool.fullDescription,
      }));
      const needsContext = fullDescriptions.some(
        (entry) => entry.description.length > GATEWAY_TOOL_DESCRIPTION_LIMIT,
      );
      if (needsContext) {
        let context =
          `${RELAY_TOOL_CONTEXT_PREFIX}\n` +
          fullDescriptions
            .map((entry) => `- ${entry.name}: ${entry.description}`)
            .join("\n");
        // The merged leading system message must still fit the gateway bound
        // after the relay context is joined with the guest system prompt(s)
        // and their separators. Reserve that space BEFORE truncating so the
        // truncation path yields a usable request instead of an oversize
        // merged message (which would be rejected as invalid_request).
        const guestSystemLength = gatewayMessages
          .filter((message) => message.role === "system")
          .map((message) => message.content.length)
          .reduce((total, length) => total + length, 0);
        const guestSystemCount = gatewayMessages.filter(
          (message) => message.role === "system" && message.content.length > 0,
        ).length;
        // One "\n\n" separator per nonempty guest system part in the merge.
        const separatorLength = guestSystemCount * 2;
        const contextBudget =
          GATEWAY_MAX_MESSAGE_CONTENT_LENGTH -
          guestSystemLength -
          separatorLength;
        if (context.length > contextBudget) {
          const marker = "\n[truncated to gateway bound]";
          context =
            contextBudget <= marker.length
              ? context.slice(0, Math.max(0, contextBudget))
              : context.slice(0, contextBudget - marker.length) + marker;
        }
        toolContext = context;
      }
      for (const tool of gatewayTools) {
        if (tool.description.length > GATEWAY_TOOL_DESCRIPTION_LIMIT) {
          throw new TranslationError("invalid_request");
        }
      }
    }
    gatewayMessages = this.mergeSystemMessages(gatewayMessages, toolContext);
    return { gatewayMessages, gatewayTools, maxOutputTokens, stream };
  }

  /**
   * Enforce the strict single-leading-system-message contract required by
   * the llama.cpp/Jinja chat template behind the gateway. Native opencode
   * bodies already start with a system prompt, so the relay tool context is
   * MERGED into that message instead of unshifted (two leading system
   * messages made LiteLLM return 500 "System message must be at the
   * beginning"). Any guest system message appearing later in history is
   * also folded into the single leading message (in original order):
   * the strict template forbids it anywhere else. Trusted relay text stays
   * before guest text, separated by a blank line.
   */
  private mergeSystemMessages(
    messages: ChatMessage[],
    toolContext: string | undefined,
  ): ChatMessage[] {
    const systemContents = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    // Fast path: one leading system message and no tool context to merge.
    if (
      toolContext === undefined &&
      systemContents.length <= 1 &&
      messages[0]?.role === "system"
    ) {
      return messages;
    }
    if (systemContents.length === 0 && toolContext === undefined) {
      return messages;
    }
    const rest = messages.filter((message) => message.role !== "system");
    if (
      toolContext !== undefined &&
      systemContents.length === 0 &&
      rest.length + 1 > GATEWAY_MAX_MESSAGES_PER_REQUEST
    ) {
      throw new TranslationError("invalid_request");
    }
    const merged = [toolContext, ...systemContents]
      .filter((part): part is string => typeof part === "string")
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (merged.length > GATEWAY_MAX_MESSAGE_CONTENT_LENGTH) {
      throw new TranslationError("invalid_request");
    }
    return [{ role: "system", content: merged }, ...rest];
  }

  /**
   * Guest message content as gateway text. Accepts a plain string, null
   * (assistant content null, including tool-call-only turns), or an array
   * of text parts (joined WITHOUT separator); rejects non-text parts
   * (images/audio) and any other shape.
   */
  private extractTextContent(entry: Record<string, unknown>): string {
    const content = entry.content;
    if (content === undefined || content === null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as unknown[])
        .map((part) => {
          if (typeof part === "string") return part;
          if (!isRecord(part)) throw new TranslationError("invalid_request");
          if (part.type === "text" && typeof part.text === "string") {
            return part.text as string;
          }
          throw new TranslationError("invalid_request");
        })
        .join("");
    }
    throw new TranslationError("invalid_request");
  }

  private translateMessage(
    entry: unknown,
    idToGateway: Map<string, string>,
  ): ChatMessage {
    if (!isRecord(entry)) throw new TranslationError("invalid_request");
    const role = entry.role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      throw new TranslationError("invalid_request");
    }
    // Null content is valid (assistant tool-call-only turns carry content
    // null); text-part arrays join without separator.
    const content = this.extractTextContent(entry);
    if (role === "tool") {
      const toolCallId = entry.tool_call_id;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new TranslationError("invalid_request");
      }
      const toolName = idToGateway.get(toolCallId);
      if (toolName === undefined)
        throw new TranslationError("unknown_tool_call_id");
      return { role: "tool", content, toolCallId, toolName };
    }
    const message: ChatMessage = { role, content };
    if (
      role === "assistant" &&
      entry.tool_calls !== undefined &&
      entry.tool_calls !== null
    ) {
      const rawCalls = entry.tool_calls;
      if (!Array.isArray(rawCalls))
        throw new TranslationError("invalid_request");
      message.toolCalls = rawCalls.map((call, index) => {
        if (!isRecord(call)) throw new TranslationError("invalid_request");
        if (call.type !== "function")
          throw new TranslationError("invalid_request");
        const fn = call.function;
        if (!isRecord(fn)) throw new TranslationError("invalid_request");
        if (!isGuestToolName(fn.name))
          throw new TranslationError("unknown_tool");
        const id =
          typeof call.id === "string" && call.id.length > 0
            ? call.id
            : `call_${index}`;
        let args: unknown = {};
        if (fn.arguments !== undefined && fn.arguments !== null) {
          if (typeof fn.arguments === "string") {
            if (fn.arguments.trim().length === 0) {
              args = {};
            } else {
              try {
                args = JSON.parse(fn.arguments);
              } catch {
                throw new TranslationError("invalid_request");
              }
              if (
                typeof args !== "object" ||
                args === null ||
                Array.isArray(args)
              ) {
                throw new TranslationError("invalid_request");
              }
            }
          } else if (isRecord(fn.arguments)) {
            args = fn.arguments;
          } else {
            throw new TranslationError("invalid_request");
          }
        }
        return { id, name: toGatewayToolName(fn.name), arguments: args };
      });
    }
    return message;
  }

  private translateTool(entry: unknown): {
    name: string;
    description: string;
    fullDescription: string;
    parameters?: Record<string, unknown>;
  } {
    if (!isRecord(entry)) throw new TranslationError("invalid_request");
    if (entry.type !== "function")
      throw new TranslationError("invalid_request");
    const fn = entry.function;
    if (!isRecord(fn)) throw new TranslationError("invalid_request");
    if (!isGuestToolName(fn.name)) throw new TranslationError("unknown_tool");
    const fullDescription =
      typeof fn.description === "string" && fn.description.length > 0
        ? (fn.description as string)
        : String(fn.name);
    // Gateway-valid short definition: keep a useful prefix of the native
    // description, always within the gateway bound. The full native text is
    // preserved separately in the trusted labeled system message.
    const suffix = " [full native description preserved in relay tool context]";
    const description =
      fullDescription.length <= RELAY_SHORT_DESCRIPTION_LIMIT
        ? fullDescription
        : `${fullDescription.slice(0, RELAY_SHORT_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
    let parameters: Record<string, unknown> | undefined;
    if (fn.parameters !== undefined && fn.parameters !== null) {
      if (!isRecord(fn.parameters))
        throw new TranslationError("invalid_request");
      parameters = fn.parameters;
    }
    return {
      name: toGatewayToolName(fn.name),
      description,
      fullDescription,
      ...(parameters === undefined ? {} : { parameters }),
    };
  }

  private renderResult(
    result: ChatResult,
    stream: boolean,
  ): { status: number; headers: Record<string, string>; body: string } {
    const toolCalls = result.toolCalls.map((call, index) => {
      const guest = toGuestToolName(call.name);
      if (guest === null) throw new Error("unknown gateway tool name");
      return {
        id: call.id,
        type: "function",
        function: {
          name: guest,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
        _index: index,
      };
    });
    const finishReason =
      toolCalls.length > 0
        ? "tool_calls"
        : result.stopReason === "tool_calls"
          ? "tool_calls"
          : result.stopReason === "unknown"
            ? "stop"
            : "stop";
    const created = Math.floor(Date.now() / 1000);
    if (!stream) {
      const message: Record<string, unknown> =
        toolCalls.length > 0
          ? {
              role: "assistant",
              content: result.text.length > 0 ? result.text : null,
              tool_calls: toolCalls.map(({ _index, ...rest }) => rest),
            }
          : { role: "assistant", content: result.text };
      const payload: Record<string, unknown> = {
        id: `chatcmpl-relay-${created}`,
        object: "chat.completion",
        created,
        model: this.fixedModel,
        choices: [{ index: 0, message, finish_reason: finishReason }],
      };
      if (result.usage !== undefined && result.usage !== null) {
        payload.usage = {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      };
    }
    // SSE parity with the synthetic responder: a single buffered content or
    // tool_calls delta chunk, then the terminal chunk, then [DONE].
    const delta: Record<string, unknown> =
      toolCalls.length > 0
        ? {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map(({ _index, ...rest }, i) => ({
              index: i,
              ...rest,
            })),
          }
        : { role: "assistant", content: result.text };
    const chunk = {
      id: `chatcmpl-relay-${created}`,
      object: "chat.completion.chunk",
      created,
      model: this.fixedModel,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    const done = {
      id: `chatcmpl-relay-${created}`,
      object: "chat.completion.chunk",
      created,
      model: this.fixedModel,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    const body = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
    return {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body,
    };
  }
}

class TranslationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "TranslationError";
    this.code = code;
  }
}

/** Closed gateway error codes that may surface in the redacted trace. */
const RELAY_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "bad_request",
  "request_cap_exceeded",
  "relay_revoked",
  "relay_not_permitted",
  "relay_busy",
  "model_call_cap_exceeded",
  "bad_json",
  "invalid_request",
  "model_mismatch",
  "unsupported_tool_choice",
  "unsupported_option",
  "unknown_tool",
  "unknown_tool_call_id",
  "model_error",
  "model_timeout",
  "invalid_response",
  "response_cap_exceeded",
  "request_failed",
  "transport_error",
  "tool_call_invalid",
  "unsupported_capability",
]);

/** Map an arbitrary code to the closed reason vocabulary (never echoes). */
function toRelayReason(code: string): RelayRequestReason {
  if (RELAY_REASONS.has(code)) return code as RelayRequestReason;
  return "model_error";
}

/**
 * Map a gateway failure to a closed error code for the fixed response body
 * and the redacted trace. Known model-local codes pass through (timeout is
 * reported as model_timeout); anything else becomes model_error. Never
 * echoes raw gateway detail; model-local validation itself is untouched.
 */
function gatewayErrorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("httpStatus" in error)) {
    return undefined;
  }
  const raw = (error as { httpStatus: unknown }).httpStatus;
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 100 &&
    raw <= 599
    ? raw
    : undefined;
}

function gatewayErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { code: unknown }).code;
    if (typeof raw === "string") {
      if (raw === "timeout") return "model_timeout";
      if (
        raw === "invalid_request" ||
        raw === "invalid_response" ||
        raw === "tool_call_invalid" ||
        raw === "answer_invalid" ||
        raw === "request_failed" ||
        raw === "transport_error" ||
        raw === "unsupported_capability"
      ) {
        return raw;
      }
    }
  }
  return "model_error";
}
