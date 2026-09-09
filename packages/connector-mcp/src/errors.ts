/** Fixed lowercase MCP error codes (§17.8). No raw errors leave this package. */
export const MCP_ERROR_CODES = [
  "mcp_unavailable",
  "mcp_binding_not_allowed",
  "mcp_schema_mismatch",
  "calendar_response_invalid",
  "calendar_upstream_error",
  "calendar_range_invalid",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
