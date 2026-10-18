// Root-side trusted trial observer (Schema12 AUTONOMY).
//
// Builds the kernel `TrustedObservation` (TrustedRuntimeObservationSchema in
// packages/contracts/src/trial_authority.ts — strict object, every field
// REQUIRED) from REAL Linux state. This module runs ONLY in the trusted Root
// service process; it is never reachable from a request body.
//
// Monotonic clock note: both Node's `process.hrtime.bigint()` and systemd's
// `ActiveEnterTimestampMonotonic` are CLOCK_MONOTONIC on Linux (microseconds
// since an unspecified boot-relative epoch — the SAME kernel clock). Verified:
// `man systemd.exec` documents ActiveEnterTimestampMonotonic as monotonic
// (CLOCK_MONOTONIC) microseconds; Node docs state hrtime uses CLOCK_MONOTONIC
// on Linux. Both share the boot epoch, so direct subtraction is valid.
//
// Unit-name formula: byte-identical copy of Own-pi
// `.pi/extensions/opencode-orchestrator/capsule.ts::expectedScopeUnit`
//   `capsule-${scopeUuid}-${scopeNonce}.scope`
// composed via `companion-protocol.ts::companionScopeIdentity`
//   `{ scopeUuid: executionId, scopeNonce: taskHash }`.
// No import of the sibling repo (by task constraint); equality is proven by
// the unit test recomputing the formula inline for a sample pair.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { TrustedRuntimeObservation } from "@companion/contracts";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const TICKS_RE = /^[1-9][0-9]{0,19}$/;

/** Byte-identical to Own-pi `companionScopeUnit({executionId, taskHash})`. */
export function expectedTrialScopeUnit(
  executionId: string,
  taskHash: string,
): string {
  if (!UUID_V4_RE.test(executionId))
    throw new Error("expectedTrialScopeUnit: executionId must be a UUID v4");
  if (!SHA256_HEX_RE.test(taskHash))
    throw new Error("expectedTrialScopeUnit: taskHash must be sha256 hex");
  // Exact Own-pi formula: `capsule-${scopeUuid}-${scopeNonce}.scope`.
  return `capsule-${executionId}-${taskHash}.scope`;
}

/** CLOCK_MONOTONIC microseconds (same clock as systemd monotonic stamps). */
export function monotonicNowUs(): bigint {
  return process.hrtime.bigint() / 1000n;
}

export type ProcessIdentity =
  | { pid: number; bootId: string; processStartTicks: string }
  | "gone"
  | "unknown";

/**
 * Parse /proc/<pid>/stat starttime (field 22, 1-indexed). The comm field
 * (field 2, in parens) may contain spaces and parens, so fields are counted
 * AFTER the LAST ')'. Returns canonical ticks text or null when malformed.
 */
export function parseProcStatStartTicks(statText: string): string | null {
  const close = statText.lastIndexOf(")");
  if (close === -1) return null;
  const rest = statText
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); field 22 (starttime) is rest[19].
  if (rest.length < 20) return null;
  const ticks = rest[19];
  if (ticks === undefined || !TICKS_RE.test(ticks)) return null;
  return ticks;
}

/** Parse /proc/sys/kernel/random/boot_id content (trimmed) or null. */
export function parseBootId(text: string): string | null {
  const bootId = text.trim();
  if (bootId.length === 0 || bootId.length > 128) return null;
  return bootId;
}

function isGoneError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "ENOENT"
  );
}

/**
 * REAL process identity: boot_id + /proc/<pid>/stat startTicks.
 * 'gone' on ENOENT (pid or file vanished); 'unknown' on EPERM/other/malformed.
 * Never throws for OS-level conditions (only for a bad pid argument).
 */
export async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid < 1 || pid > 4294967295)
    throw new Error(
      "readProcessIdentity: pid must be a positive int32-range integer",
    );
  let bootId: string | null;
  let stat: string;
  try {
    const [bootRaw, statRaw] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    bootId = parseBootId(bootRaw);
    stat = statRaw;
  } catch (e) {
    if (isGoneError(e)) return "gone";
    return "unknown"; // EPERM/EACCES/any other failure: fail closed, never throw.
  }
  const ticks = parseProcStatStartTicks(stat);
  if (bootId === null || ticks === null) return "unknown";
  return { pid, bootId, processStartTicks: ticks };
}

export interface ScopeUnitProps {
  scopeState: "active" | "gone" | "unknown";
  /** Raw parsed properties (present when the show call succeeded). */
  loadState?: string | undefined;
  activeState?: string | undefined;
  activeEnterMonotonicUs?: bigint | null | undefined;
  runtimeMaxUsec?: bigint | "infinity" | null | undefined;
  memoryMax?: string | undefined;
  tasksMax?: string | undefined;
  cpuQuotaPerSecUsec?: string | undefined;
  remainingRuntimeMs?: number | null | undefined;
}

const SHOW_PROPS =
  "LoadState,ActiveState,ActiveEnterTimestampMonotonic,RuntimeMaxUSec,MemoryMax,TasksMax,CPUQuotaPerSecUSec";

/**
 * Strict key=value parser for `systemctl show` output. Unknown/missing keys
 * yield null fields (never defaults); garbage lines are ignored.
 */
export function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z]+$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Parse a systemd `*USec` property. `systemctl show` renders time spans in
 * human form ("20s", "1min 30s", "500ms") rather than raw microseconds, so
 * both plain integers (microseconds) and strict "<int><unit>( ...)" spans
 * are accepted. Unknown units/malformed text -> null (fail closed, never a
 * default). "infinity" passes through for the caller to deny.
 */
const USEC_PER_UNIT: Record<string, bigint> = {
  us: 1n,
  usec: 1n,
  usecs: 1n,
  ms: 1000n,
  msec: 1000n,
  msecs: 1000n,
  s: 1_000_000n,
  sec: 1_000_000n,
  secs: 1_000_000n,
  second: 1_000_000n,
  seconds: 1_000_000n,
  min: 60_000_000n,
  mins: 60_000_000n,
  minute: 60_000_000n,
  minutes: 60_000_000n,
  h: 3_600_000_000n,
  hr: 3_600_000_000n,
  hrs: 3_600_000_000n,
  hour: 3_600_000_000n,
  hours: 3_600_000_000n,
  d: 86_400_000_000n,
  day: 86_400_000_000n,
  days: 86_400_000_000n,
  w: 604_800_000_000n,
  week: 604_800_000_000n,
  weeks: 604_800_000_000n,
};
export function parseSystemdUsec(
  value: string | undefined,
): bigint | "infinity" | null {
  if (value === undefined) return null;
  if (value === "infinity") return "infinity";
  if (/^[0-9]{1,20}$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  const parts = value.split(" ");
  if (parts.length === 0 || parts.length > 8) return null;
  let total = 0n;
  for (const part of parts) {
    const m = /^([0-9]{1,20})([a-z]+)$/.exec(part);
    if (!m) return null;
    const mult = USEC_PER_UNIT[m[2] as string];
    if (mult === undefined) return null;
    total += BigInt(m[1] as string) * mult;
    if (total > 9_223_372_036_854_775_807n) return null; // int64 overflow guard.
  }
  return total;
}

function parseUs(value: string | undefined): bigint | "infinity" | null {
  return parseSystemdUsec(value);
}

/**
 * remainingRuntimeMs = ceil((enter + runtimeMax - nowMonoUs) / 1000).
 * Returns 0 when RuntimeMax has already elapsed while the unit is still
 * loaded (the scope is tearing down, NOT unknown — the caller keeps waiting
 * for 'gone' post-exit and denies the permit pre-permit). Returns null when
 * any input is missing/infinite/non-positive-out-of-range.
 */
export function computeRemainingRuntimeMs(
  activeEnterMonotonicUs: bigint | null | undefined,
  runtimeMaxUsec: bigint | "infinity" | null | undefined,
  nowMonotonicUs: bigint,
): number | null {
  if (activeEnterMonotonicUs === null || activeEnterMonotonicUs === undefined)
    return null;
  if (
    runtimeMaxUsec === null ||
    runtimeMaxUsec === undefined ||
    runtimeMaxUsec === "infinity"
  )
    return null; // infinity RuntimeMax: deny (unknown remaining).
  const diffUs = activeEnterMonotonicUs + runtimeMaxUsec - nowMonotonicUs;
  if (diffUs <= 0n) return 0;
  const ms = Number((diffUs + 999n) / 1000n); // ceil to ms.
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3600000) return null;
  return ms;
}

function classifyScopeState(
  loadState: string | undefined,
  activeState: string | undefined,
): "active" | "gone" | "unknown" {
  if (loadState === "not-found") return "gone";
  if (loadState === "loaded" && activeState === "active") return "active";
  return "unknown";
}

export interface QueryScopeOptions {
  /** XDG_RUNTIME_DIR value for the target user session (passed explicitly). */
  xdgRuntimeDir: string;
  /** Per-call deadline for the systemctl invocation. */
  timeoutMs?: number | undefined;
  /** Injected clock (tests only). */
  nowMonotonicUs?: bigint | undefined;
}

/**
 * REAL scope query: `systemctl --user show -p ... <unit>` via execFile (no
 * shell), with XDG_RUNTIME_DIR passed explicitly in the child env (never
 * inherited ambient config). Any failure/timeout/garbage -> scopeState
 * 'unknown' (fail closed, never throws except for bad arguments).
 */
export async function queryScopeUnit(
  systemctlRealpath: string,
  unit: string,
  options: QueryScopeOptions,
): Promise<ScopeUnitProps> {
  if (
    typeof systemctlRealpath !== "string" ||
    systemctlRealpath.length === 0 ||
    systemctlRealpath.includes("\0")
  )
    throw new Error(
      "queryScopeUnit: systemctlRealpath must be a non-empty path",
    );
  if (typeof unit !== "string" || unit.length === 0 || unit.includes("\0"))
    throw new Error("queryScopeUnit: unit must be a non-empty string");
  if (
    typeof options.xdgRuntimeDir !== "string" ||
    options.xdgRuntimeDir.length === 0
  )
    throw new Error("queryScopeUnit: xdgRuntimeDir is required");
  const timeoutMs = options.timeoutMs ?? 5000;
  const nowUs = options.nowMonotonicUs ?? monotonicNowUs();
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        systemctlRealpath,
        ["--user", "show", "-p", SHOW_PROPS, unit],
        {
          env: {
            XDG_RUNTIME_DIR: options.xdgRuntimeDir,
            PATH: "/usr/bin:/bin",
          },
          timeout: timeoutMs,
          maxBuffer: 65536,
        },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        },
      );
      void child;
    });
  } catch {
    return { scopeState: "unknown" };
  }
  const kv = parseSystemctlShow(stdout);
  const loadState = kv.LoadState;
  const activeState = kv.ActiveState;
  const scopeState = classifyScopeState(loadState, activeState);
  if (scopeState !== "active") {
    return { scopeState, loadState, activeState };
  }
  const enterRaw = kv.ActiveEnterTimestampMonotonic;
  const enter: bigint | null =
    enterRaw !== undefined && /^[0-9]{1,20}$/.test(enterRaw)
      ? BigInt(enterRaw)
      : null;
  const runtimeMax = parseUs(kv.RuntimeMaxUSec);
  const remaining =
    enter !== null ? computeRemainingRuntimeMs(enter, runtimeMax, nowUs) : null;
  // Semantics: loaded+active with elapsed RuntimeMax (remaining 0) is still
  // 'active' (tearing down) — NOT 'unknown'. Pre-permit, remaining<=0 denies
  // via kernel fit/validation; post-exit, only 'gone' counts (keep polling
  // for gone until the deadline). 'unknown' is reserved for missing/infinite
  // RuntimeMax, unparsable stamps, or failed/inactive units.
  const props: ScopeUnitProps = {
    scopeState: remaining === null ? "unknown" : "active",
    loadState,
    activeState,
    activeEnterMonotonicUs: enter,
    runtimeMaxUsec: runtimeMax,
    memoryMax: kv.MemoryMax,
    tasksMax: kv.TasksMax,
    cpuQuotaPerSecUsec: kv.CPUQuotaPerSecUSec,
    remainingRuntimeMs: remaining,
  };
  return props;
}

export interface ObserveTrialInput {
  executionId: string;
  taskHash: string;
  /** Native frontend pid whose identity anchors the observation. */
  pid: number;
  systemctlRealpath: string;
  /** XDG_RUNTIME_DIR for the user session owning the scope. */
  xdgRuntimeDir: string;
  /** Caller-known gate state (observer never invents it). */
  foregroundGateOpen: boolean;
  /** Caller-known child exit/settled state (observer never invents it). */
  frontendSettled: boolean;
  /**
   * Caller-frozen bridge maxOutputBytes. The observer copies it ONLY because
   * the caller passes the frozen bridge-config value; the kernel still
   * re-checks equality against the wire budget (mismatch => deny).
   */
  bridgeMaxOutputBytes: number;
  systemctlTimeoutMs?: number | undefined;
}

/**
 * Assemble the kernel TrustedObservation from REAL Linux state.
 * Throws (deny) when: unit name invalid, process identity gone/unknown,
 * scope not active, remaining uncomputable/out of schema range, or
 * bridgeMaxOutputBytes outside schema bounds.
 *
 * timeoutMs is DERIVED from RuntimeMaxUSec (ceil to ms) — the launcher must
 * therefore set RuntimeMaxSec=ceil(wireTimeoutMs/1000) so the derived value
 * byte-matches the frozen wire budget the kernel re-checks. maxOutputBytes
 * is the caller-frozen bridge config value (documented above).
 */
export async function observeTrialExecution(
  input: ObserveTrialInput,
): Promise<TrustedRuntimeObservation> {
  const unit = expectedTrialScopeUnit(input.executionId, input.taskHash);
  const identity = await readProcessIdentity(input.pid);
  if (identity === "gone" || identity === "unknown")
    throw new Error(
      `observeTrialExecution: frontend process identity ${identity}`,
    );
  const scope = await queryScopeUnit(input.systemctlRealpath, unit, {
    xdgRuntimeDir: input.xdgRuntimeDir,
    ...(input.systemctlTimeoutMs !== undefined
      ? { timeoutMs: input.systemctlTimeoutMs }
      : {}),
  });
  if (scope.scopeState !== "active" || scope.remainingRuntimeMs == null)
    throw new Error(
      "observeTrialExecution: scope not active with known remaining",
    );
  // Elapsed RuntimeMax (remaining 0 while still loaded): tearing down, deny.
  if (scope.remainingRuntimeMs <= 0)
    throw new Error(
      "observeTrialExecution: RuntimeMax elapsed (remaining 0 denies permit)",
    );
  if (scope.runtimeMaxUsec === "infinity" || scope.runtimeMaxUsec == null)
    throw new Error(
      "observeTrialExecution: unbounded RuntimeMax denies permit",
    );
  const timeoutMs = Number((scope.runtimeMaxUsec + 999n) / 1000n);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
    throw new Error("observeTrialExecution: derived timeoutMs out of range");
  if (
    !Number.isInteger(input.bridgeMaxOutputBytes) ||
    input.bridgeMaxOutputBytes < 1024 ||
    input.bridgeMaxOutputBytes > 268435456
  )
    throw new Error("observeTrialExecution: bridgeMaxOutputBytes out of range");
  const ob: TrustedRuntimeObservation = {
    scopeState: "active",
    frontendSettled: input.frontendSettled,
    pid: identity.pid,
    bootId: identity.bootId,
    processStartTicks: identity.processStartTicks,
    remainingRuntimeMs: scope.remainingRuntimeMs,
    timeoutMs,
    maxOutputBytes: input.bridgeMaxOutputBytes,
    foregroundGateOpen: input.foregroundGateOpen,
    observedAt: Date.now(),
  };
  return ob;
}
