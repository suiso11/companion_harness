// Ollama HTTP adapter: non-streaming POST to `{base}/api/chat`.
//
// Native `message.tool_calls` only; assistant `content` text is never
// parsed for tool calls (no free-text JSON emulation).

import { ModelLocalError } from "./errors.js";
import {
  assertAssistantTextWithinBound,
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

export const OLLAMA_PROVIDER = "ollama" as const;
export const OLLAMA_CHAT_PATH = "/api/chat";

export const OLLAMA_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
};

function toolArgumentsFromNative(
  value: unknown,
  index: number,
  toolName: string,
): unknown {
  void index;
  if (value === undefined) {
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
    // serialized size. No free-text fallback. answer.submit failures use
    // fixed answer_invalid; ordinary keeps tool_call_invalid.
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

/** Normalize an Ollama `/api/chat` JSON body (native fields only). */
export function normalizeOllamaResponse(
  body: unknown,
  requestedTools: readonly ToolDefinition[] | undefined,
): ChatResult {
  if (!isRecord(body) || !isRecord(body.message)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  const message = body.message;
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
  // Text bound first (character semantics, same as ChatMessage
  // validation): oversize text rejects the whole response as fixed
  // invalid_response before any tool-call parsing, so an oversize batch
  // containing a malformed answer.submit still fails as invalid_response
  // (never answer_invalid, never repaired) and no tool executes.
  assertAssistantTextWithinBound(text);
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
      if (!isRecord(entry) || !isRecord(entry.function)) {
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
        arguments: toolArgumentsFromNative(
          entry.function.arguments,
          index,
          name,
        ),
      });
    });
  }
  validateNativeToolCalls({ toolCalls, requestedTools });
  const doneReason =
    typeof body.done_reason === "string" ? body.done_reason : "";
  const usage = extractModelUsage(body.prompt_eval_count, body.eval_count);
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : mapStopReason(doneReason),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Serialize one provider-neutral message to Ollama `/api/chat` shape.
 * Assistant history with prior native `toolCalls` replays as native
 * `tool_calls`; tool results stay `{role:"tool",content,tool_name}` (Ollama
 * correlates via `tool_name`; `tool_call_id` is unsupported and never
 * emitted). No free-text parsing is performed.
 */
export function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role !== "tool") {
    if (message.toolCallId !== undefined || message.toolName !== undefined) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries tool correlation on a non-tool role",
      );
    }
  }
  if (
    message.role === "assistant" &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: call.arguments ?? {} },
      })),
    };
  }
  if (message.role === "tool") {
    // Ollama tool feedback correlates by originating tool name only.
    // Never emit the OpenAI-style `tool_call_id` / `toolCallId` field.
    // Require both provider-neutral fields so a bare uncorrelated tool
    // message is rejected here even if request validation is bypassed.
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
      tool_name: message.toolName,
    };
  }
  return { role: message.role, content: message.content };
}

function mapStopReason(doneReason: string): ChatResult["stopReason"] {
  if (doneReason === "stop" || doneReason === "") {
    return "stop";
  }
  return "unknown";
}

/** Create an Ollama-backed gateway (loopback HTTP only). */
export function createOllamaGateway(options: GatewayOptions): ModelGateway {
  const config = resolveGatewayConfig(options);
  const chatUrl = joinLoopbackPath(config.baseUrl, OLLAMA_CHAT_PATH);
  return {
    provider: OLLAMA_PROVIDER,
    capabilities: OLLAMA_CAPABILITIES,
    baseUrl: config.baseUrl,
    chatUrl,
    async chat(request, options) {
      validateChatRequest(request);
      assertToolCallingCapability(OLLAMA_CAPABILITIES, request.tools);
      // Recompute the fetch target from the pinned base on every request
      // (never reuse the exposed `chatUrl` property) so a mutated gateway
      // field cannot redirect the request; postJsonNoRedirect revalidates
      // the literal loopback target immediately before fetch.
      const url = joinLoopbackPath(config.baseUrl, OLLAMA_CHAT_PATH);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
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
      }
      const raw = await postJsonNoRedirect({
        fetchImpl: config.fetchImpl,
        url,
        body,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return normalizeOllamaResponse(raw, request.tools);
    },
  };
}
