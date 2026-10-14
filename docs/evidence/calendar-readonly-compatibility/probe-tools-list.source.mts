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
 * Reproduce (portable exact-checkout replay; credential-stripped, no tokens):
 *   Prerequisites (temporary exact fork checkout, not committed):
 *     git fetch origin 6939311fd3eae9846648e0a175e304c9500f578e
 *     git checkout 6939311fd3eae9846648e0a175e304c9500f578e -- <fork-dir>
 *     (verify: git rev-parse HEAD = FORK_COMMIT; git rev-parse HEAD^{tree}
 *     = FORK_TREE; sha256 of package-lock.json = FORK_LOCK_DIGEST)
 *     env -i PATH=<allow> HOME=<owned-tmp> npm ci --ignore-scripts \
 *       --no-audit --no-fund --prefix <fork-dir>
 *     No Google/GH tokens, no OAuth, no network at probe time.
 *   1. Save this file's essence as <owned-tmp>/min-probe.ts with the import
 *      below rewritten to an absolute path to the fork's
 *      src/tools/registry.ts (this published copy uses a relative path
 *      valid only from docs/evidence/calendar-readonly-compatibility/).
 *   2. Bundle WITHOUT dependencies (they stay external, nothing executes):
 *      <fork-dir>/node_modules/.bin/esbuild <owned-tmp>/min-probe.ts --bundle
 *        --platform=node --format=esm --packages=external \
 *        --outfile=<owned-tmp>/.min-probe-tmp.mjs
 *   3. Run offline credential-stripped:
 *      env -i PATH=<allow> HOME=<owned-tmp> node <owned-tmp>/.min-probe-tmp.mjs
 *   4. Delete the bundle immediately: rm <owned-tmp>/.min-probe-tmp.mjs
 *
 * Diagnostic only: registry-direct bytes use a different serializer than the
 * live SDK wire; the binding pin is the liveWire form (see candidate pin).
 *
 * Expected surface for 3.0.0-readonly.2: exactly
 *   list-events, search-events, get-event
 * (`list-calendars` is NOT registered and must be absent.)
 */
import { createHash } from "node:crypto";
import { ToolRegistry } from "../../../.readonly-compat/fork/src/tools/registry.ts";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
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
  const digest = createHash("sha256").update(canonical).digest("hex");
  console.log(`${tool.name} ${digest}`);
}
