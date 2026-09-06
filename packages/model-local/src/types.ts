// Shared provider-neutral types for the local model gateway.

/** Roles allowed on gateway chat messages. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** Optional provider usage summary (token counts only, when reported). */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Single chat message. Tool results carry the originating `toolCallId` + `toolName`. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  /**
   * Originating tool name for `role: "tool"` feedback (ordinary or synthetic).
   * Serialized provider-natively: Ollama `tool_name`, omitted on the
   * OpenAI-compatible wire (which correlates via `tool_call_id` only).
   */
  toolName?: string;
  /**
   * Prior native assistant tool calls for multi-step replay.
   * Only valid on `assistant` messages; serialized provider-natively
   * (Ollama `tool_calls` / OpenAI `tool_calls`) without free-text parsing.
   */
  toolCalls?: NormalizedToolCall[];
}

/** Tool definition advertised to the model for native function calling. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** Provider-neutral chat request. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

/** Normalized native tool call (never derived from free-text content). */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Normalized chat result: assistant text plus native tool calls. */
export interface ChatResult {
  text: string;
  toolCalls: NormalizedToolCall[];
  stopReason: "stop" | "tool_calls" | "unknown";
  /** Optional token counts only; absent when the provider omits them. */
  usage?: ModelUsage | null;
}

/** Provider capability advertisement. */
export interface ModelCapabilities {
  toolCalling: boolean;
}

/** Injectable fetch implementation (tests supply a mock; default: global). */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Common gateway construction options. */
export interface GatewayOptions {
  baseUrl: string;
  /** Default model name used when a request omits one (not used: model required). */
  apiKey?: string;
  fetchImpl?: FetchImpl;
  /** Single-attempt abort timeout in ms; no retries. */
  timeoutMs?: number;
}
