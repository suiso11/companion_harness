import { z } from "zod";

/** 64 KiB stderr cap (§17.7, exact). */
export const STDERR_CAP_BYTES = 64 * 1024;

const loopbackHost = z
  .string()
  .refine(
    (host) => host === "127.0.0.1" || host === "localhost",
    {
      message:
        "Streamable HTTP host must be loopback (127.0.0.1/localhost)",
    },
  );

const stdioTransport = z.object({
  kind: z.literal("stdio"),
  /** Config-only command: absolute or bare binary name, no interpolation. */
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(1024)).max(32).default([]),
  /** Explicit env allowlist: only these names are passed to the child. */
  envAllowlist: z.array(z.string().min(1).max(128)).max(32).default([]),
  shutdownWaitMs: z.number().int().min(100).max(10000).default(3000),
});

const httpTransport = z.object({
  kind: z.literal("streamable-http"),
  host: loopbackHost,
  port: z.number().int().min(1).max(65535),
  path: z.string().startsWith("/").max(256).default("/mcp"),
  /** Redirects are always refused; this flag documents the fixed behavior. */
  followRedirects: z.literal(false).default(false),
});

const bindingSchema = z.object({
  /** Exact upstream tool name as configured (e.g. `search-events`). */
  upstreamTool: z.string().min(1).max(128),
  /** Canonical input-schema SHA-256 hex (64 chars) for binding identity. */
  canonicalSchemaHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const mcpConnectorConfigSchema = z
  .object({
    connectorInstanceId: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    kind: z.literal("mcp"),
    /** Version of the bound upstream surface (fork/release version). */
    version: z.string().min(1).max(64),
    transport: z.discriminatedUnion("kind", [stdioTransport, httpTransport]),
    /** Explicit allowlist only; tools/list is never auto-exposed (§17.3). */
    bindings: z.array(bindingSchema).min(1).max(16),
    clientName: z.string().min(1).max(128).default("companion-harness"),
    clientVersion: z.string().min(1).max(64).default("0.0.0"),
  })
  .strict();

export type McpConnectorConfig = z.infer<typeof mcpConnectorConfigSchema>;
export type McpTransportConfig = McpConnectorConfig["transport"];
export type McpBinding = McpConnectorConfig["bindings"][number];

/** Canonical JSON (recursive key sort) + SHA-256 hex for schema hashes (§17.3). */
export async function canonicalSchemaHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeys(value));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
