// Dedupe state helpers for best-effort in-app ops notifications.
//
// Pure functions only: the shell hooks load/save the JSON state file, these
// functions decide whether a notice should be emitted. Everything here is
// best-effort — malformed state is treated as empty state.
//
// Deploy-skip dedupe (state: ~/.local/state/companion/deploy-skip.json):
// a target that keeps being skipped (CI not green / active runs) emits at
// most one info notice per hour window, and only after the skip has
// persisted for more than an hour.
//
// Health dedupe (state: ~/.local/state/companion/health-notify.json):
// each distinct problem key emits one error notice when it first appears,
// stays silent while it persists, and emits one info ("recovered") notice
// when it clears.

export const SKIP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Fold one skipped tick for `target` into the state.
 * Returns { state, notify } — notify=true only when the skip has persisted
 * for at least one hour window since the last emitted notice.
 */
export function nextSkipState(state, target, now, windowMs = SKIP_WINDOW_MS) {
  const targets = { ...(state?.targets ?? {}) };
  const prev = targets[target];
  if (prev === undefined) {
    // First skipped tick for this target: start the episode silently.
    targets[target] = { firstSkipAt: now, lastNotifiedAt: now };
    return { state: { ...state, targets }, notify: false };
  }
  if (now - prev.lastNotifiedAt >= windowMs) {
    targets[target] = { ...prev, lastNotifiedAt: now };
    return { state: { ...state, targets }, notify: true };
  }
  return { state: { ...state, targets }, notify: false };
}

/** Clear a target's skip episode (deploy succeeded or target changed). */
export function clearSkipState(state, target) {
  if (state?.targets?.[target] === undefined) return state;
  const targets = { ...(state.targets ?? {}) };
  delete targets[target];
  return { ...state, targets };
}

/**
 * Fold one health probe result for `key` into the state.
 * Returns { state, level } where level is "error" on first failure,
 * "recovered" when a failing key clears, and null otherwise.
 */
export function nextHealthState(state, key, failing, now) {
  const keys = { ...(state?.keys ?? {}) };
  const wasFailing = keys[key] !== undefined;
  if (failing) {
    if (wasFailing) return { state: { ...state, keys }, level: null };
    keys[key] = now;
    return { state: { ...state, keys }, level: "error" };
  }
  if (!wasFailing) return { state: { ...state, keys }, level: null };
  delete keys[key];
  return { state: { ...state, keys }, level: "recovered" };
}

// --- CLI surface (thin, best-effort; used by the shell hooks) ---
// node opsNotifyState.mjs skip <target>        -> prints "notify" | "silent"
// node opsNotifyState.mjs skip-clear <target>  -> prints "ok"
// node opsNotifyState.mjs health <key> failing|ok
//                                              -> prints "error"|"recovered"|"silent"

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultStatePath(name, env = process.env) {
  const base =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(base, "companion", name);
}

function loadState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function runCli(argv, env = process.env, now = Date.now()) {
  const [command, key, arg] = argv;
  if (command === "skip" && typeof key === "string" && key.length > 0) {
    const path = defaultStatePath("deploy-skip.json", env);
    const { state, notify } = nextSkipState(loadState(path), key, now);
    saveState(path, state);
    return notify ? "notify" : "silent";
  }
  if (command === "skip-clear" && typeof key === "string" && key.length > 0) {
    const path = defaultStatePath("deploy-skip.json", env);
    saveState(path, clearSkipState(loadState(path), key));
    return "ok";
  }
  if (
    command === "health" &&
    typeof key === "string" &&
    key.length > 0 &&
    (arg === "failing" || arg === "ok")
  ) {
    const path = defaultStatePath("health-notify.json", env);
    const { state, level } = nextHealthState(
      loadState(path),
      key,
      arg === "failing",
      now,
    );
    saveState(path, state);
    return level ?? "silent";
  }
  return "usage";
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1])
) {
  const verdict = runCli(process.argv.slice(2));
  process.stdout.write(`${verdict}\n`);
}
