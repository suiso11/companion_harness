// Ollama HTTP adapter: non-streaming POST to `{base}/api/chat`.
//
// Native `message.tool_calls` only; assistant `content` text is never
// parsed for tool calls (no free-text JSON emulation).

import { ModelLocalError } from "./errors.js";
import {
  assertToolCallingCapability,
  extractModelUsage,
  isRecord,
  joinLoopbackPath,
  type ModelGateway,
  postJsonNoRedirect,
  resolveGatewayConfig,
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

function toolArgumentsFromNative(value: unknown, index: number): unknown {
  void index;
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) {
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof ModelLocalError) {
        throw error;
      }
      throw new ModelLocalError(
        "tool_call_invalid",
        "model returned an invalid tool call",
      );
    }
  }
  throw new ModelLocalError(
    "tool_call_invalid",
    "model returned an invalid tool call",
  );
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
  const toolCalls: NormalizedToolCall[] = [];
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    message.tool_calls.forEach((entry: unknown, index: number) => {
      if (!isRecord(entry) || !isRecord(entry.function)) {
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      const name = entry.function.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new ModelLocalError(
          "tool_call_invalid",
          "model returned an invalid tool call",
        );
      }
      const id =
        typeof entry.id === "string" && entry.id.length > 0
          ? entry.id
          : `call_${index}`;
      toolCalls.push({
        id,
        name,
        arguments: toolArgumentsFromNative(entry.function.arguments, index),
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
    if (message.toolName !== undefined) {
      return {
        role: message.role,
        content: message.content,
        tool_name: message.toolName,
      };
    }
    return { role: message.role, content: message.content };
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
        url: chatUrl,
        body,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return normalizeOllamaResponse(raw, request.tools);
    },
  };
}
