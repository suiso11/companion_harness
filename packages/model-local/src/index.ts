// @companion/model-local — loopback-only local model gateway.
//
// Provider-neutral ModelGateway plus Ollama (`/api/chat`) and
// OpenAI-compatible (`/v1/chat/completions`) HTTP adapters. Native tool
// calling only; no streaming, retry, fallback, routing, logs, or
// persistence.

export {
  assertPinnedLoopbackFetchUrl,
  normalizeLoopbackBaseUrl,
} from "./base_url.js";
export {
  MODEL_LOCAL_ERROR_CODES,
  ModelLocalError,
  type ModelLocalErrorCode,
} from "./errors.js";
export {
  assertToolArgumentsByteLength,
  assertToolCallingCapability,
  canonicalToolArgumentsJson,
  extractModelUsage,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MESSAGES_PER_REQUEST,
  MAX_MODEL_NAME_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
  MAX_TOOL_CALL_ID_LENGTH,
  MAX_TOOL_CALL_NAME_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_TOOLS_PER_REQUEST,
  type ModelGateway,
  type ResolvedGatewayConfig,
  resolveGatewayConfig,
  utf8ByteLength,
  validateChatRequest,
  validateNativeToolCalls,
} from "./gateway.js";
export {
  createOllamaGateway,
  normalizeOllamaResponse,
  OLLAMA_CAPABILITIES,
  OLLAMA_CHAT_PATH,
  OLLAMA_PROVIDER,
  toOllamaMessage,
} from "./ollama.js";
export {
  createOpenAICompatibleGateway,
  normalizeOpenAIResponse,
  OPENAI_COMPATIBLE_CAPABILITIES,
  OPENAI_COMPATIBLE_PROVIDER,
  resolveOpenAIChatUrl,
  toOpenAIMessage,
} from "./openai_compatible.js";
export type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatRole,
  FetchImpl,
  GatewayOptions,
  ModelCapabilities,
  ModelUsage,
  NormalizedToolCall,
  ToolDefinition,
} from "./types.js";
