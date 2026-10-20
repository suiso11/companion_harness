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
//   node remindDeploy.mjs field <key> [--memory-json RAW] [--config PATH]
//                              [--fallback VALUE]
//     prints entry/config/executable/scope, preferring COMPANION_MEMORY_JSON.
//   node remindDeploy.mjs check-ok
//     reads one response envelope from stdin; exit 0 only for
//     { v: 1, ok: true, code: "OK" }.
// Never prints config contents or request bodies.

import { readFileSync } from "node:fs";

function parseMemoryJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** One string field from COMPANION_MEMORY_JSON (e.g. entry/config/scope). */
export function memoryValue(raw, key) {
  const value = parseMemoryJson(raw)?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract the Companion memory scope from COMPANION_MEMORY_JSON. */
export function scopeFromMemoryJson(raw) {
  return memoryValue(raw, "scope");
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

/**
 * Resolve how to invoke the remind CLI for the smoke test. The Companion
 * address (COMPANION_MEMORY_JSON) wins for executable/entry/config/scope;
 * otherwise fall back to the just-deployed CLI and the remind config.
 */
export function resolveSmokeTarget({
  memoryJson,
  configPath,
  fallbackEntry,
  fallbackExecutable,
  fallbackConfig,
} = {}) {
  const config =
    memoryValue(memoryJson, "config") ?? fallbackConfig ?? configPath ?? null;
  return {
    executable:
      memoryValue(memoryJson, "executable") ?? fallbackExecutable ?? null,
    entry: memoryValue(memoryJson, "entry") ?? fallbackEntry ?? null,
    config,
    scope: scopeFromMemoryJson(memoryJson) ?? readAllowedScope(config),
  };
}

// Strict smoke validation, mirroring the production client rules in
// apps/server/src/memory_cli.ts (parseMemoryCliStdout): exactly one
// LF-terminated line framed on raw bytes, a plain object with exactly the
// envelope keys, a closed code set, v===1, boolean ok/message/deduplicated,
// data object|null.

const MEMORY_CLI_ENVELOPE_MAX_BYTES = 65536;

const CLI_ENVELOPE_CODES = new Set([
  "OK",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN_SCOPE",
  "STORE_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "TIMEOUT",
]);

const ENVELOPE_KEYS = new Set([
  "v",
  "ok",
  "code",
  "message",
  "data",
  "deduplicated",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Byte-level framing validation, a text replica of the framing half of
 * parseMemoryCliStdout: exactly one trailing LF byte, no other LF byte in
 * the body, no NUL bytes, within maxBytes. Returns null when malformed,
 * else the decoded line (without its trailing LF).
 */
export function parseCliStdoutFrame(
  raw,
  maxBytes = MEMORY_CLI_ENVELOPE_MAX_BYTES,
) {
  const buf =
    typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw ?? "");
  if (buf.length === 0 || buf.length > maxBytes) {
    return null;
  }
  if (buf[buf.length - 1] !== 0x0a || buf.indexOf(0x0a) !== buf.length - 1) {
    return null;
  }
  if (buf.includes(0)) {
    return null;
  }
  const body = buf.subarray(0, buf.length - 1);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  return text.length === 0 ? null : text;
}

/** True only for a well-formed ok:true remind response envelope:
 * exactly one LF-terminated line; JSON object with exactly the keys
 * {v,ok,code,message,data,deduplicated}; v===1; ok===true; code in the
 * closed envelope set (success smoke => OK); string message; boolean
 * deduplicated; data null or a plain object. Mirrors the production client
 * (apps/server/src/memory_cli.ts) so a candidate that passes this smoke can
 * never be rejected as cli_malformed by Companion.
 */
export function isOkEnvelope(raw) {
  const text = parseCliStdoutFrame(raw);
  if (text === null) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) {
    return false;
  }
  for (const key of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return false;
    }
  }
  if (
    parsed.v !== 1 ||
    typeof parsed.ok !== "boolean" ||
    typeof parsed.code !== "string" ||
    !CLI_ENVELOPE_CODES.has(parsed.code) ||
    typeof parsed.message !== "string" ||
    typeof parsed.deduplicated !== "boolean" ||
    (parsed.data !== null && !isPlainObject(parsed.data))
  ) {
    return false;
  }
  return parsed.ok === true;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--memory-json" && i + 1 < argv.length) {
      out.memoryJson = argv[++i];
    } else if (argv[i] === "--config" && i + 1 < argv.length) {
      out.configPath = argv[++i];
    } else if (argv[i] === "--fallback" && i + 1 < argv.length) {
      out.fallback = argv[++i];
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
  } else if (command === "field") {
    // `field <key> [--memory-json RAW] [--config PATH] [--fallback VALUE]`
    const key = rest[0];
    const args = parseArgs(rest.slice(1));
    const target = resolveSmokeTarget({
      memoryJson: args.memoryJson,
      configPath: args.configPath,
      fallbackEntry: args.fallback,
      fallbackExecutable: args.fallback,
      // `field config --fallback` seeds the remind config path when
      // COMPANION_MEMORY_JSON carries no config (deploy smoke path).
      fallbackConfig: key === "config" ? args.fallback : undefined,
    });
    const value =
      key === "scope" ||
      key === "entry" ||
      key === "config" ||
      key === "executable"
        ? target[key]
        : null;
    if (value === null || value === "") {
      process.stderr.write(`remindDeploy: no ${key ?? "field"} available\n`);
      process.exit(1);
    }
    process.stdout.write(`${value}\n`);
  } else if (command === "check-ok") {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    process.exit(isOkEnvelope(raw.trim()) ? 0 : 1);
  } else {
    process.stderr.write(
      "usage: remindDeploy.mjs scope [--memory-json RAW] [--config PATH]\n" +
        "       remindDeploy.mjs field <entry|config|executable|scope> [...] [--fallback VALUE]\n" +
        "       remindDeploy.mjs check-ok\n",
    );
    process.exit(2);
  }
}
