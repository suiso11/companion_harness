// Pure helpers for the frozen trial-operator builder. Kept dependency-free so
// they can be unit-tested without touching the host or the deployed tree.

const ALIAS_RE = /^[a-z0-9_-]{1,64}$/;
const ABS_RE = /^\//;

function fail(message) {
  throw new Error(`trial operator: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needObject(value, name) {
  if (!isRecord(value)) fail(`${name} must be an object`);
  return value;
}

function needString(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function needInt(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function needPositivePaths(record, name, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = needString(record[key], `${name}.${key}`, ABS_RE);
  }
  return out;
}

const RUNTIME_KEYS = [
  "nodeRealpath",
  "ompRealpath",
  "bwrapRealpath",
  "systemdRunRealpath",
  "systemctlRealpath",
  "piOrchLauncherRealpath",
  "piOrchShellRealpath",
  "piOrchConfigRealpath",
  "piOrchExtensionRealpath",
  "piOrchLockRealpath",
];

const INPUT_KEYS = [
  "workspaceAlias",
  "sourceRepo",
  "sourceRef",
  "stateRoot",
  "operatorFile",
  "environmentFile",
  "mandatoryChecks",
  "limits",
  "runner",
  "runtime",
];

// Validate the small host input file. Unknown keys are rejected so host
// drift is loud rather than silently ignored.
export function validateTrialOperatorInput(raw) {
  const input = needObject(raw, "input");
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) fail(`input has an unknown key: ${key}`);
  }
  const workspaceAlias = needString(
    input.workspaceAlias,
    "workspaceAlias",
    ALIAS_RE,
  );
  const sourceRepo = needString(input.sourceRepo, "sourceRepo", ABS_RE);
  const sourceRef = needString(input.sourceRef, "sourceRef");
  const stateRoot = needString(input.stateRoot, "stateRoot", ABS_RE);
  const operatorFile = needString(input.operatorFile, "operatorFile", ABS_RE);
  const environmentFile = needString(
    input.environmentFile,
    "environmentFile",
    ABS_RE,
  );
  const checks = input.mandatoryChecks;
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 16) {
    fail("mandatoryChecks must be a non-empty array (max 16)");
  }
  const seen = new Set();
  for (const check of checks) {
    if (typeof check !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(check)) {
      fail("mandatoryChecks contains an invalid name");
    }
    if (seen.has(check)) fail("mandatoryChecks contains a duplicate");
    seen.add(check);
  }
  const limits = needObject(input.limits, "limits");
  for (const key of Object.keys(limits)) {
    if (
      ![
        "timeoutMs",
        "maxOutputBytes",
        "maxModelCalls",
        "maxOutputTokens",
        "maxModelCallMs",
        "maxConcurrent",
        "jobsPerDay",
      ].includes(key)
    ) {
      fail(`limits has an unknown key: ${key}`);
    }
  }
  const runner = needObject(input.runner, "runner");
  const relay = needObject(runner.relay, "runner.relay");
  const observe = needObject(runner.observe, "runner.observe");
  const runtime = needPositivePaths(
    needObject(input.runtime, "runtime"),
    "runtime",
    RUNTIME_KEYS,
  );
  return {
    workspaceAlias,
    sourceRepo,
    sourceRef,
    stateRoot,
    operatorFile,
    environmentFile,
    mandatoryChecks: [...checks],
    limits: {
      timeoutMs: needInt(limits.timeoutMs, "limits.timeoutMs", 1, 900_000),
      maxOutputBytes: needInt(
        limits.maxOutputBytes,
        "limits.maxOutputBytes",
        1,
        262_144,
      ),
      maxModelCalls: needInt(
        limits.maxModelCalls,
        "limits.maxModelCalls",
        1,
        64,
      ),
      maxOutputTokens: needInt(
        limits.maxOutputTokens,
        "limits.maxOutputTokens",
        1,
        4096,
      ),
      maxModelCallMs: needInt(
        limits.maxModelCallMs,
        "limits.maxModelCallMs",
        1,
        60_000,
      ),
      maxConcurrent: needInt(
        limits.maxConcurrent,
        "limits.maxConcurrent",
        1,
        1,
      ),
      jobsPerDay: needInt(limits.jobsPerDay ?? 3, "limits.jobsPerDay", 0, 100),
    },
    runner: {
      relay: {
        maxRequestBytes: needInt(
          relay.maxRequestBytes,
          "runner.relay.maxRequestBytes",
          1,
          1_048_576,
        ),
        maxModelCalls: needInt(
          relay.maxModelCalls,
          "runner.relay.maxModelCalls",
          1,
          64,
        ),
        maxOutputTokens: needInt(
          relay.maxOutputTokens,
          "runner.relay.maxOutputTokens",
          1,
          4096,
        ),
        maxResponseBytes: needInt(
          relay.maxResponseBytes,
          "runner.relay.maxResponseBytes",
          1,
          1_048_576,
        ),
        perCallTimeoutMs: needInt(
          relay.perCallTimeoutMs,
          "runner.relay.perCallTimeoutMs",
          1,
          60_000,
        ),
        maxConcurrent: needInt(
          relay.maxConcurrent,
          "runner.relay.maxConcurrent",
          1,
          1,
        ),
      },
      observe: {
        activeTimeoutMs: needInt(
          observe.activeTimeoutMs,
          "runner.observe.activeTimeoutMs",
          1,
          60_000,
        ),
        goneTimeoutMs: needInt(
          observe.goneTimeoutMs,
          "runner.observe.goneTimeoutMs",
          1,
          60_000,
        ),
        pollIntervalMs: needInt(
          observe.pollIntervalMs,
          "runner.observe.pollIntervalMs",
          1,
          60_000,
        ),
      },
      pollMs: needInt(runner.pollMs, "runner.pollMs", 1, 60_000),
    },
    runtime,
  };
}

// systemd's EnvironmentFile parser understands shell-like single quotes; it
// strips the quotes and yields the JSON verbatim. The JSON we emit never
// contains a single quote, and one cannot be escaped inside single quotes.
export function formatAutonomyEnvLine(json) {
  if (typeof json !== "string" || json.length === 0) {
    fail("autonomy JSON must be a non-empty string");
  }
  if (json.includes("'") || /[\r\n]/.test(json)) {
    fail("autonomy JSON must not contain quotes or newlines");
  }
  JSON.parse(json);
  return `COMPANION_AUTONOMY_JSON='${json}'\n`;
}

const FROZEN_ROOT_RE = /^frozen-[0-9a-f]{7,40}-(\d{8}T\d{6}Z)$/;

// Select old frozen roots to prune, newest first by the timestamp suffix. The
// root name also contains the commit sha, so comparing whole names would order
// by sha first; the timestamp is the only creation-order key.
export function selectFrozenRootsToPrune(names, currentRootName, keep = 2) {
  if (!Number.isInteger(keep) || keep < 1) fail("keep must be >= 1");
  const frozen = names
    .map((name) => ({ name, match: FROZEN_ROOT_RE.exec(name) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      const byTime = (b.match?.[1] ?? "").localeCompare(a.match?.[1] ?? "");
      return byTime !== 0 ? byTime : b.name.localeCompare(a.name);
    })
    .map((entry) => entry.name);
  const keepSet = new Set();
  for (const name of [currentRootName, ...frozen]) {
    if (keepSet.size >= keep) break;
    keepSet.add(name);
  }
  return frozen.filter((name) => !keepSet.has(name));
}

// Return only the command map entries the host selected. The materializer
// config requires the command map size to equal the configured check list,
// so a single-check host profile must not receive both commands.
export function selectCheckCommands(available, selected) {
  const out = {};
  for (const id of selected) {
    if (
      typeof id !== "string" ||
      typeof available !== "object" ||
      available === null ||
      !(id in available)
    ) {
      fail(`unsupported mandatoryChecks entry: ${String(id)}`);
    }
    out[id] = available[id];
  }
  return out;
}
