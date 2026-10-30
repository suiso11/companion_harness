// Self-improvement loop measurement (P0/P1): deterministic, host-observed
// labels only. No model judgment is ever a label here; the loop's own
// confidence values are inputs to calibration, never ground truth.
//
// Everything in this module is pure: the repository layer supplies the run
// facts, and the same functions back both the CLI report and the tests.

import { createHash } from "node:crypto";

/** One in ten runs is held out of all learning and used only for evaluation. */
export const LOOP_QUARANTINE_MODULUS = 10;

/** Tool-call outcomes that make a run's execution unhealthy. */
export const LOOP_TOOL_FAILURE_OUTCOMES = [
  "failed",
  "invalid",
  "denied",
  "timed_out",
  "unknown",
] as const;

/** Deterministic task classes (first matching family wins, alphabetical). */
export const LOOP_TASK_CLASSES = [
  "agora",
  "calendar",
  "chat",
  "handoff",
  "learning",
  "memory",
  "purpose",
  "reference",
  "task",
  "trial",
  "web",
] as const;

export type LoopTaskClass = (typeof LOOP_TASK_CLASSES)[number];

/** Deterministic 10% hold-out: sha256(runId)[0] % 10 === 0. */
export function isQuarantinedRun(runId: string): boolean {
  const digest = createHash("sha256").update(runId, "utf8").digest();
  return digest.readUInt8(0) % LOOP_QUARANTINE_MODULUS === 0;
}

/** Classify a run by the first tool family it used (deterministic). */
export function classifyTaskClass(tools: readonly string[]): LoopTaskClass {
  for (const family of LOOP_TASK_CLASSES) {
    if (family === "chat") continue;
    if (tools.some((tool) => tool.startsWith(`${family}.`))) return family;
  }
  return "chat";
}

export interface LoopRunFacts {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
  /** model_calls rows with a non-null error_code. */
  readonly modelErrors: number;
  /** tool_calls rows with an unhealthy actual_outcome. */
  readonly toolErrors: number;
  readonly tools: readonly string[];
}

export interface LoopRunLabel {
  readonly runId: string;
  readonly sessionId: string;
  readonly taskClass: LoopTaskClass;
  /** Deterministic label: completed and no model/tool failure. */
  readonly ok: boolean;
  readonly quarantined: boolean;
}

export function labelRun(facts: LoopRunFacts): LoopRunLabel {
  return {
    runId: facts.runId,
    sessionId: facts.sessionId,
    taskClass: classifyTaskClass(facts.tools),
    ok:
      facts.status === "completed" &&
      facts.modelErrors === 0 &&
      facts.toolErrors === 0,
    quarantined: isQuarantinedRun(facts.runId),
  };
}

export interface LoopClassCoverage {
  readonly taskClass: LoopTaskClass;
  readonly n: number;
  readonly ok: number;
  readonly quarantined: number;
}

export interface LoopCoverage {
  readonly total: number;
  readonly labeled: number;
  readonly quarantined: number;
  readonly byClass: readonly LoopClassCoverage[];
}

export function computeCoverage(labels: readonly LoopRunLabel[]): LoopCoverage {
  const classes: Record<
    LoopTaskClass,
    { n: number; ok: number; quarantined: number }
  > = Object.fromEntries(
    LOOP_TASK_CLASSES.map((name) => [name, { n: 0, ok: 0, quarantined: 0 }]),
  ) as Record<LoopTaskClass, { n: number; ok: number; quarantined: number }>;
  let quarantined = 0;
  for (const label of labels) {
    const row = classes[label.taskClass];
    row.n += 1;
    if (label.ok) row.ok += 1;
    if (label.quarantined) {
      row.quarantined += 1;
      quarantined += 1;
    }
  }
  return {
    total: labels.length,
    labeled: labels.length,
    quarantined,
    byClass: LOOP_TASK_CLASSES.filter((name) => classes[name].n > 0).map(
      (name) => ({ taskClass: name, ...classes[name] }),
    ),
  };
}

export interface CalibrationPair {
  /** The model's stated confidence, binarized at the fixed threshold. */
  readonly confident: boolean;
  /** The host-observed outcome. */
  readonly ok: boolean;
}

export type DprimeResult =
  | {
      readonly status: "insufficient";
      readonly n: number;
      readonly minPairs: number;
      readonly minPerCell: number;
    }
  | {
      readonly status: "ok";
      readonly n: number;
      readonly hitRate: number;
      readonly falseAlarmRate: number;
      readonly dprime: number;
      readonly criterion: number;
    };

export const DPRIME_MIN_PAIRS = 50;
export const DPRIME_MIN_PER_CELL = 10;
export const CONFIDENCE_THRESHOLD = 0.7;

/** Acklam's inverse normal CDF (|error| < 1.15e-9). */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0,1)");
  const [a0, a1, a2, a3, a4, a5] = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const [b0, b1, b2, b3, b4] = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ] as const;
  const [c0, c1, c2, c3, c4, c5] = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ] as const;
  const [d0, d1, d2, d3] = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ] as const;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  const rational = (q: number): number =>
    (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
    ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  if (p < pLow) return rational(Math.sqrt(-2 * Math.log(p)));
  if (p > pHigh) return -rational(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

/**
 * Type-2 sensitivity over (confidence, host outcome) pairs.
 * d' = z(HR2) - z(FAR2) with a log-linear (+0.5) correction; criterion
 * c = -0.5 * (z(HR2) + z(FAR2)). Below the minimum sample it reports
 * `insufficient` and the caller must not use the value.
 */
export function computeDprime(
  pairs: readonly CalibrationPair[],
  options: {
    readonly minPairs?: number;
    readonly minPerCell?: number;
  } = {},
): DprimeResult {
  const minPairs = options.minPairs ?? DPRIME_MIN_PAIRS;
  const minPerCell = options.minPerCell ?? DPRIME_MIN_PER_CELL;
  let hit = 0;
  let miss = 0;
  let falseAlarm = 0;
  let correctReject = 0;
  for (const pair of pairs) {
    if (pair.confident) {
      if (pair.ok) hit += 1;
      else miss += 1;
    } else if (pair.ok) {
      correctReject += 1;
    } else {
      falseAlarm += 1;
    }
  }
  const n = pairs.length;
  if (
    n < minPairs ||
    hit + miss < minPerCell ||
    falseAlarm + correctReject < minPerCell
  ) {
    return { status: "insufficient", n, minPairs, minPerCell };
  }
  const hitRate = (hit + 0.5) / (hit + miss + 1);
  const falseAlarmRate = (falseAlarm + 0.5) / (falseAlarm + correctReject + 1);
  const dprime = inverseNormal(hitRate) - inverseNormal(falseAlarmRate);
  const criterion =
    -0.5 * (inverseNormal(hitRate) + inverseNormal(falseAlarmRate));
  return { status: "ok", n, hitRate, falseAlarmRate, dprime, criterion };
}
