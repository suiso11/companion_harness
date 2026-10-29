// Operator-allowlisted host env, snapshotted by the bridge at OMP launch and
// bound read-only into the guest. Kept pure/small so the merge rules are
// testable without starting the guest.
import { readFileSync, writeFileSync } from "node:fs";

export const FORWARDED_ENV_MAX_BYTES = 64 * 1024;
const FORWARDED_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isForbidden(name) {
  return name === "HOME" || name === "TMPDIR" || name.startsWith("COMPANION_");
}

/** Parse the JSON env object, dropping invalid/forbidden/oversized entries. */
export function parseForwardedGuestEnv(text) {
  if (typeof text !== "string") return {};
  if (Buffer.byteLength(text, "utf8") > FORWARDED_ENV_MAX_BYTES) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (
      !FORWARDED_ENV_NAME.test(name) ||
      isForbidden(name) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Read one forwarded env file; missing/unreadable files mean "no overrides". */
export function readForwardedGuestEnv(path) {
  try {
    return parseForwardedGuestEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Snapshot the allowlisted host env at OMP launch into a private JSON file.
 * Only names present in `env` as strings are written; values never touch
 * argv/config/logs.
 */
export function writeGuestEnvSnapshot(path, names, env) {
  const values = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") values[name] = value;
  }
  writeFileSync(path, `${JSON.stringify(values)}\n`, { mode: 0o600 });
  return values;
}
