// Shared provider-neutral types for the local model gateway.

/** Roles allowed on gateway chat messages. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * OpenAI-compatible `tool_choice` policy applied when tools are offered.
 * `required` makes every model step call a tool (the kernel's final answer
 * is still the reserved `answer.submit` tool call); `auto` lets the model
 * answer in prose. The Ollama adapter ignores this option (tool_choice is
 * not part of its wire format).
 */
export type ModelToolChoice = "auto" | "required";

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
  /**
   * Optional per-call output token cap. When present, serialized
   * provider-natively (OpenAI-compatible `max_tokens`, Ollama
   * `options.num_predict`); absent means no cap is sent.
   */
  maxOutputTokens?: number;
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

/**
 * Incremental streaming delta emitted while a `stream:true` response is
 * being read (PR-2). Pieces are provisional and unvalidated: only the
 * final ChatResult carries validated output. `content` is plain assistant
 * text, `reasoning` is `reasoning_content` (thinking), `draft` is the
 * newly decoded suffix of `answer.submit` `parts[].text` extracted from
 * partial tool-call argument JSON (provisional, replaced by the validated
 * answer), and `usage` is the terminal token summary (present only when
 * the provider honors `stream_options.include_usage`).
 */
export type ModelStreamDelta =
  | { kind: "content"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "draft"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number };

/** Optional per-chunk callback receiving provisional streaming deltas. */
export type ModelStreamDeltaCallback = (delta: ModelStreamDelta) => void;

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
  /**
   * Opt-in streaming (PR-2, default off / additive). When true the
   * OpenAI-compatible adapter sends `stream:true` with
   * `stream_options:{include_usage:true}` and accumulates SSE deltas into
   * the same ChatResult the non-streaming path returns. Absent/false keeps
   * the exact `stream:false` behavior. There is no automatic fallback: a
   * streaming failure surfaces with the same redacted error classes as the
   * non-streaming path.
   */
  streamingEnabled?: boolean;
  /**
   * `tool_choice` sent with tool-bearing OpenAI-compatible requests.
   * Defaults to `required` so a model that would answer in prose must call a
   * tool instead (the kernel treats a content-only step as `free_text`).
   * Pass `auto` to restore provider defaults. Ignored by the Ollama adapter.
   */
  toolChoice?: ModelToolChoice;
}
