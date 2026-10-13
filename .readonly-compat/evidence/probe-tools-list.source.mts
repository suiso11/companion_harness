/**
 * Minimal credential-free tools/list identity probe (source record).
 *
 * Scope: imports ONLY the fork ToolRegistry (schemas + registration table),
 * enumerates tools via getToolsWithSchemas(), and prints
 * "<tool-name> <canonical-input-schema-sha256>" per tool.
 * Canonical form MUST match packages/connector-mcp canonicalSchemaHash
 * (recursive key sort + JSON.stringify + SHA-256 hex, §17.3).
 *
 * What it does NOT do: no transport, no OAuth, no account provisioning,
 * no provider I/O, no live Google HTTP, no secrets. stdlib network is
 * never touched. Safe to run offline after `npm ci --ignore-scripts`.
 *
 * Reproduce (from the fork checkout, exact-SHA):
 *   1. Save this file's essence as /tmp/min-probe.ts with the import
 *      below rewritten to an absolute path to the fork's
 *      src/tools/registry.ts (this archived copy uses a relative path
 *      valid only from .readonly-compat/evidence/).
 *   2. Bundle WITHOUT dependencies (they stay external, nothing executes):
 *      node_modules/.bin/esbuild /tmp/min-probe.ts --bundle --platform=node \
 *        --format=esm --packages=external --outfile=.min-probe-tmp.mjs
 *   3. Run offline: node .min-probe-tmp.mjs
 *   4. Delete the bundle immediately: rm .min-probe-tmp.mjs
 *
 * Expected surface for 3.0.0-readonly.2: exactly
 *   list-events, search-events, get-event
 * (`list-calendars` is NOT registered and must be absent.)
 */
import { createHash } from 'node:crypto';
import { ToolRegistry } from '../fork/src/tools/registry.ts';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const tools = ToolRegistry.getToolsWithSchemas();
for (const tool of tools) {
  const canonical = JSON.stringify(sortKeys(tool.inputSchema));
  const digest = createHash('sha256').update(canonical).digest('hex');
  console.log(`${tool.name} ${digest}`);
}
