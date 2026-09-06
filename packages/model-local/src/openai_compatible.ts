// OpenAI-compatible HTTP adapter: non-streaming POST to
// `{base}/v1/chat/completions` (a base URL already ending in `/v1`
// becomes `{base}/chat/completions`).
//
// Native `choices[0].message.tool_calls` only; assistant `content` text is
// never parsed for tool calls (no free-text JSON emulation).

import { ModelLocalError } from "./errors.js";
import {
  assertToolCallingCapability,
  extractModelUsage,
  isRecord,
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

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible" as const;

export const OPENAI_COMPATIBLE_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
};

/** Resolve the chat-completions URL without doubling a `/v1` prefix. */
export function resolveOpenAIChatUrl(normalizedBaseUrl: string): string {
  if (normalizedBaseUrl === "/v1" || normalizedBaseUrl.endsWith("/v1")) {
    return `${normalizedBaseUrl}/chat/completions`;
  }
  return `${normalizedBaseUrl}/v1/chat/completions`;
}

function toolArgumentsFromNative(value: unknown): unknown {
  if (value === undefined || value === null) {
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
        arguments: toolArgumentsFromNative(entry.function.arguments),
      });
    });
  }
  validateNativeToolCalls({ toolCalls, requestedTools });
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  const usageRecord = isRecord(body.usage) ? body.usage : undefined;
  const usage =
    usageRecord === undefined
      ? undefined
      : extractModelUsage(
          usageRecord.prompt_tokens,
          usageRecord.completion_tokens,
        );
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
 * `tool_calls` (JSON-string arguments); tool results carry `tool_call_id`.
 * No free-text parsing is performed.
 */
export function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.role === "tool" && message.toolCallId !== undefined) {
    entry.tool_call_id = message.toolCallId;
  }
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
        url: chatUrl,
        body,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return normalizeOpenAIResponse(raw, request.tools);
    },
  };
}
