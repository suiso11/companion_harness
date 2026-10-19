// Helpers for remind-deploy.sh: smoke-test scope resolution and envelope
// validation. Kept out of the shell so the selection rules are unit-tested.
//
// Scope preference (the deploy smoke must use a scope the running remind
// config accepts):
//   1. `scope` from COMPANION_MEMORY_JSON (the Companion startup address).
//   2. the first entry of `allowedScopes` in the remind config.
//
// CLI:
//   node remindDeploy.mjs scope [--memory-json RAW] [--config PATH]
//     prints the selected scope (empty + exit 1 when none is available).
//   node remindDeploy.mjs check-ok
//     reads one response envelope from stdin; exit 0 only for
//     { v: 1, ok: true, code: "OK" }.
// Never prints config contents or request bodies.

import { readFileSync } from "node:fs";

/** Extract the Companion memory scope from COMPANION_MEMORY_JSON. */
export function scopeFromMemoryJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const scope = parsed?.scope;
  return typeof scope === "string" && scope.length > 0 ? scope : null;
}

/** First allowedScope from a remind memory.config.json, or null. */
export function readAllowedScope(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  const scopes = parsed?.allowedScopes;
  if (!Array.isArray(scopes)) {
    return null;
  }
  const first = scopes[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** Resolve the smoke-test scope, preferring the Companion address. */
export function resolveSmokeScope({ memoryJson, configPath } = {}) {
  return scopeFromMemoryJson(memoryJson) ?? readAllowedScope(configPath);
}

/** True only for a well-formed ok:true remind response envelope. */
export function isOkEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return parsed?.v === 1 && parsed?.ok === true && parsed?.code === "OK";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--memory-json" && i + 1 < argv.length) {
      out.memoryJson = argv[++i];
    } else if (argv[i] === "--config" && i + 1 < argv.length) {
      out.configPath = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      out.help = true;
    }
  }
  return out;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(
    process.argv[1].split("/").slice(-1)[0].split("\\").slice(-1)[0],
  );

if (invokedAsMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "scope") {
    const args = parseArgs(rest);
    const scope = resolveSmokeScope({
      memoryJson: args.memoryJson,
      configPath: args.configPath,
    });
    if (scope === null) {
      process.stderr.write("remindDeploy: no smoke scope available\n");
      process.exit(1);
    }
    process.stdout.write(`${scope}\n`);
  } else if (command === "check-ok") {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    process.exit(isOkEnvelope(raw.trim()) ? 0 : 1);
  } else {
    process.stderr.write(
      "usage: remindDeploy.mjs scope [--memory-json RAW] [--config PATH]\n" +
        "       remindDeploy.mjs check-ok\n",
    );
    process.exit(2);
  }
}
