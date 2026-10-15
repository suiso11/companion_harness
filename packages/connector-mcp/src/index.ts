/**
 * C15 fake-E2E seam: the OFFICIAL SDK inert transport pair. Production code
 * never uses it; the dedicated Calendar fake E2E harness pairs a scripted
 * fake MCP server with the real Client over this transport so the real
 * connector pipeline (handshake, tools/list identity, tools/call) runs
 * without any network, process spawn or OAuth surface.
 */

/**
 * M5 trusted-test stdio seam: the OFFICIAL SDK stdio client transport.
 * Production code never uses it (production spawns through
 * `defaultTransportFactory` from the validated hint command); the
 * reschedule write-profile server tests use it ONLY inside the
 * options-injected `writeMcpTransportFactory` to spawn the TRACKED fixture
 * server over REAL stdio with fixture-only env set in the CHILD process.
 * Never used by production code.
 */
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
/**
 * C15 fake-E2E seam (append): the SDK low-level `Server` and the exact wire
 * request schemas for scripted ListTools/CallTool handling, so the dedicated
 * Calendar fake E2E harness registers literal JSON input schemas whose
 * canonical hashes link config/definitions to the live tools/list result
 * byte-for-byte. Never used by production code.
 */
export { Server } from "@modelcontextprotocol/sdk/server/index.js";
export {
  type CallToolRequest,
  CallToolRequestSchema,
  type ListToolsRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
export { nextBackoffMs } from "./backoff.js";
export {
  assertLoopbackHttp,
  assertStdioEnvClosed,
  type CallResult,
  type ConnectorStats,
  defaultTransportFactory,
  loopbackNoRedirectFetch,
  McpConnector,
  type McpConnectorPolicyOptions,
  missingStdioEnvNames,
  STDIO_IMPLICIT_ENV_VARS,
  startupEnvTransportFactory,
  type TransportFactory,
} from "./client.js";
export {
  canonicalSchemaHash,
  type McpBinding,
  type McpBindingDefinition,
  type McpConnectorConfig,
  type McpTransportConfig,
  mcpConnectorConfigSchema,
  STDERR_CAP_BYTES,
} from "./config.js";
export { MCP_ERROR_CODES, type McpErrorCode } from "./errors.js";
