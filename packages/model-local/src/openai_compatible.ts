// OpenAI-compatible HTTP adapter: non-streaming POST to
// `{base}/v1/chat/completions` (a base URL already ending in `/v1`
// becomes `{base}/chat/completions`).
//
// Native `choices[0].message.tool_calls` only; assistant `content` text is
// never parsed for tool calls (no free-text JSON emulation).

import { ModelLocalError } from "./errors.js";
import {
  assertNativeToolCallName,
  assertToolArgumentsByteLengthForTool,
  assertToolCallCountWithinBound,
  assertToolCallingCapability,
  canonicalToolArgumentsJson,
  extractModelUsage,
  isRecord,
  joinLoopbackPath,
  type ModelGateway,
  normalizeNativeToolCallId,
  postJsonNoRedirect,
  resolveGatewayConfig,
  throwInvalidToolArguments,
  utf8ByteLength,
  validateChatRequest,
  validateNativeToolCalls,
} from "./gateway.js";
import type {
  ChatMessage,
  ChatResult,
  GatewayOptions,
  ModelCapabilities,
  NormalizedToolCall,
  ToolDefinition,
} from "./types.js";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible" as const;

export const OPENAI_COMPATIBLE_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
};

/** Resolve the chat-completions URL without doubling a `/v1` prefix. */
export function resolveOpenAIChatUrl(normalizedBaseUrl: string): string {
  const basePath = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "");
  if (basePath === "/v1" || basePath.endsWith("/v1")) {
    return joinLoopbackPath(normalizedBaseUrl, "/chat/completions");
  }
  return joinLoopbackPath(normalizedBaseUrl, "/v1/chat/completions");
}

function toolArgumentsFromNative(value: unknown, toolName: string): unknown {
  if (value === undefined || value === null) {
    return {};
  }
  if (isRecord(value)) {
    // Object form: measure deterministic serialized UTF-8 bytes (never
    // truncated, never echoed). Oversize rejects the whole response:
    // answer.submit as fixed answer_invalid, ordinary as invalid_response.
    assertToolArgumentsByteLengthForTool(
      utf8ByteLength(canonicalToolArgumentsJson(value)),
      toolName,
    );
    return value;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return {};
    }
    // Byte-check the raw string before JSON.parse (bytes, not characters),
    // then validate the parsed JSON and re-check its deterministic
    // serialized size (catches whitespace/compression tricks and aligns
    // with the broker canonical-input measure). No free-text fallback.
    // answer.submit failures use fixed answer_invalid; ordinary keeps
    // tool_call_invalid.
    assertToolArgumentsByteLengthForTool(utf8ByteLength(value), toolName);
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) {
        throwInvalidToolArguments(toolName);
      }
      assertToolArgumentsByteLengthForTool(
        utf8ByteLength(canonicalToolArgumentsJson(parsed)),
        toolName,
      );
      return parsed;
    } catch (error) {
      if (error instanceof ModelLocalError) {
        throw error;
      }
      throwInvalidToolArguments(toolName);
    }
  }
  throwInvalidToolArguments(toolName);
}

/** Normalize an OpenAI-compatible `/v1/chat/completions` JSON body. */
export function normalizeOpenAIResponse(
  body: unknown,
  requestedTools: readonly ToolDefinition[] | undefined,
): ChatResult {
  if (
    !isRecord(body) ||
    !Array.isArray(body.choices) ||
    body.choices.length === 0
  ) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  const message = choice.message;
  let text = "";
  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content !== "string") {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    text = message.content;
  }
  const toolCalls: NormalizedToolCall[] = [];
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    // Atomic: any oversize/invalid call throws before a ChatResult is
    // built, so a response containing one oversize call is never
    // partially accepted. The shared per-message count bound rejects
    // before per-call argument parsing so an over-count batch containing
    // a malformed answer.submit still fails as invalid_response.
    assertToolCallCountWithinBound(message.tool_calls.length);
    message.tool_calls.forEach((entry: unknown, index: number) => {
      if (!isRecord(entry)) {
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      // Native calls only when entry.type is exactly "function" (case- and
      // whitespace-sensitive, no coercion). An explicit non-function string
      // type is an unsupported variant: reject as invalid_response without
      // inspecting or executing any function-shaped payload. A missing or
      // non-string type (or a missing/invalid function payload below)
      // rejects as tool_call_invalid. Fixed redacted messages only.
      if (entry.type !== "function") {
        if (typeof entry.type === "string") {
          throw new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          );
        }
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      if (!isRecord(entry.function)) {
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      const name = assertNativeToolCallName(entry.function.name);
      const id = normalizeNativeToolCallId(entry.id, index);
      toolCalls.push({
        id,
        name,
        arguments: toolArgumentsFromNative(entry.function.arguments, name),
      });
    });
  }
  validateNativeToolCalls({ toolCalls, requestedTools });
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  const rawUsage: unknown = body.usage;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  if (rawUsage === undefined || rawUsage === null) {
    usage = undefined;
  } else if (!isRecord(rawUsage)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  } else {
    usage = extractModelUsage(
      rawUsage.prompt_tokens,
      rawUsage.completion_tokens,
    );
  }
  return {
    text,
    toolCalls,
    stopReason:
      toolCalls.length > 0 || finishReason === "tool_calls"
        ? "tool_calls"
        : finishReason === "stop" || finishReason === ""
          ? "stop"
          : "unknown",
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Serialize one provider-neutral message to OpenAI chat-completions shape.
 * Assistant history with prior native `toolCalls` replays as native
 * `tool_calls` (JSON-string arguments); tool results carry `tool_call_id`
 * only (`tool_name` is unsupported and never emitted, even when the
 * provider-neutral message carries `toolName`).
 * No free-text parsing is performed.
 */
export function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role !== "tool") {
    if (message.toolCallId !== undefined || message.toolName !== undefined) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries tool correlation on a non-tool role",
      );
    }
  }
  if (message.role === "tool") {
    // OpenAI tool results correlate via `tool_call_id` only (`tool_name`
    // is unsupported and never emitted, even when the provider-neutral
    // message carries `toolName`). Require both provider-neutral fields so
    // a bare uncorrelated tool message is rejected here even if request
    // validation is bypassed.
    if (
      typeof message.toolCallId !== "string" ||
      message.toolCallId.length === 0 ||
      typeof message.toolName !== "string" ||
      message.toolName.length === 0
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries an invalid tool call id",
      );
    }
    return {
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  const entry: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (
    message.role === "assistant" &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    entry.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      },
    }));
  }
  return entry;
}

/** Create an OpenAI-compatible gateway (loopback HTTP only). */
export function createOpenAICompatibleGateway(
  options: GatewayOptions,
): ModelGateway {
  const config = resolveGatewayConfig(options);
  const chatUrl = resolveOpenAIChatUrl(config.baseUrl);
  return {
    provider: OPENAI_COMPATIBLE_PROVIDER,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    baseUrl: config.baseUrl,
    chatUrl,
    async chat(request, options) {
      validateChatRequest(request);
      assertToolCallingCapability(
        OPENAI_COMPATIBLE_CAPABILITIES,
        request.tools,
      );
      // Recompute from the pinned base per request (see Ollama adapter):
      // mutated `chatUrl` state is ignored and the fetch boundary
      // revalidates the literal loopback target.
      const url = resolveOpenAIChatUrl(config.baseUrl);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map(toOpenAIMessage),
        stream: false,
      };
      if (request.tools !== undefined && request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? {
              type: "object",
              properties: {},
            },
          },
        }));
        body.tool_choice = "auto";
      }
      const raw = await postJsonNoRedirect({
        fetchImpl: config.fetchImpl,
        url,
        body,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return normalizeOpenAIResponse(raw, request.tools);
    },
  };
}
