// Conversation -> frozen plan -> standing-policy grant -> EXISTING TrialRunner.
//
// This module owns ONLY the policy/plan/execution ledger and the trusted-host
// authorization decision. It deliberately reuses:
//   - autonomy purposes/tasks for bounded execution-task derivation,
//   - trial_authority for the immutable one-use grant (CAS/one-use/fence/
//     claim/launch-permit/result/quiescence all stay in that owner),
//   - the server's existing TrialRunner poll loop for spawning.
//
// There is no scheduler, queue, worker pool, or learning store here. A policy
// is created once by an authenticated human through the same-origin HTTP API;
// the model can never create, enlarge, or approve a policy. Default off: an
// unset server config creates no policy, and autonomy_control starts paused.

import { createHash } from "node:crypto";
import type {
  TrialOperation,
  TrialProfileSnapshot,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { parseStrictInstantMs } from "./action_strategy.js";
import {
  type CreatePurposeInput,
  type CreateTaskInput,
  createPurpose,
  createTask,
} from "./autonomy.js";
import {
  canonicalJsonString,
  generateId,
  withImmediateTx,
} from "./canonical.js";
import {
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import {
  derivePolicyTrialGrant,
  type PolicyGrantInput,
} from "./trial_authority.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_PLAN_HISTORY_TURNS = 20;
const MAX_PATHS = 16;
const MAX_LIST = 100;

export const AUTODISPATCH_SOURCE = "standing-policy" as const;

export type StandingPolicyStatus = "active" | "revoked" | "expired";
export type DispatchPlanStatus =
  | "frozen"
  | "needs_decision"
  | "discuss"
  | "blocked"
  | "superseded"
  | "dispatched";
export type DispatchExecutionStatus =
  | "reserved"
  | "authorized"
  | "blocked"
  | "denied"
  | "superseded";
export type IntentKind = "execute" | "discuss" | "unclear";

export interface PolicyCaps {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxModelCalls: number;
  readonly maxOutputTokens: number;
  readonly perCallTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
  readonly jobsPerDay: number;
  readonly concurrentExecutions: number;
}

/** Conservative, disclosed proposal (never silently applied to a policy). */
export const DEFAULT_POLICY_CAPS: PolicyCaps = Object.freeze({
  timeoutMs: 900_000,
  maxOutputBytes: 4096,
  maxModelCalls: 24,
  maxOutputTokens: 2048,
  perCallTimeoutMs: 120_000,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576,
  maxConcurrent: 1,
  jobsPerDay: 3,
  concurrentExecutions: 1,
});

/** Operator config upper bounds; a policy can never exceed these. */
export interface AutodispatchLimits {
  readonly operations: readonly TrialOperation[];
  readonly checks: readonly string[];
  readonly caps: PolicyCaps;
}

export interface StandingPolicyView {
  readonly id: string;
  readonly sessionId: string;
  readonly parentPurposeId: string;
  readonly workspaceAlias: string;
  readonly version: number;
  readonly status: StandingPolicyStatus;
  readonly operations: readonly TrialOperation[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly checks: readonly string[];
  readonly caps: PolicyCaps;
  readonly expiresAt: string | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
}

export interface CreateStandingPolicyInput {
  readonly workspaceAlias: string;
  readonly operations: readonly TrialOperation[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly checks: readonly string[];
  readonly caps: PolicyCaps;
  readonly expiresAt?: string | null;
}

export interface IntentQuote {
  readonly turnId: string;
  readonly runId: string;
  readonly text: string;
  readonly seq: number;
}

export interface PlanIntent {
  readonly kind: IntentKind;
  readonly quotes: readonly IntentQuote[];
  readonly latestUserTurnId: string;
  readonly latestUserRunId: string;
  /** Fixed label: the model may summarize but never author provenance. */
  readonly provenance: "user-conversation";
}

export interface DispatchPlanContent {
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly nongoals: readonly string[];
  readonly steps: readonly string[];
  readonly acceptance: readonly string[];
  readonly missing: readonly string[];
  readonly relevantPaths: readonly string[];
}

export interface DispatchPlanView {
  readonly id: string;
  readonly sessionId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly revision: number;
  readonly planHash: string;
  readonly status: DispatchPlanStatus;
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly nongoals: readonly string[];
  readonly steps: readonly string[];
  readonly acceptance: readonly string[];
  readonly missing: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly operation: TrialOperation;
  readonly workspaceAlias: string;
  readonly intent: PlanIntent;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly createdAt: number;
}

/** Public-safe materialization readiness summary. Never carries a path,
 * config key, artifact body, or host-applied/task-done claim. */
export interface DispatchMaterializationSummary {
  readonly configFingerprint: string;
  readonly sourceRevision: string;
  readonly sourceManifestDigest: string;
  readonly dependencyDigest: string;
  readonly executorDigest: string;
  readonly materializationDigest: string;
}

export interface DispatchExecutionView {
  readonly id: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: DispatchExecutionStatus;
  readonly reason: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly dependencyDigest: string | null;
  readonly materialization: DispatchMaterializationSummary | null;
  readonly createdAt: number;
}

export interface AuthorizeWithinPolicyOptions {
  readonly profile: TrialProfileSnapshot;
  readonly workspaceAlias: string;
  readonly limits: AutodispatchLimits;
  /** Host-preallocated UUID bound to the materialized execution. Optional for
   * legacy/manual callers; trusted host only (never a model/body field). */
  readonly executionId?: string;
  /** Verified dependency depot digest bound to this reservation/grant. */
  readonly dependencyDigest?: string;
  /** Immutable per-execution materialization reference (private host state;
   * persisted on the existing ledger row, never projected publicly). */
  readonly materialization?: unknown;
  readonly materializationDigest?: string;
  readonly now?: number;
}

function nowMs(input?: number): number {
  const now = input ?? Date.now();
  if (!Number.isInteger(now) || now < 0) {
    throw new RepositoryValidationError("now must be integer Unix-ms");
  }
  return now;
}
function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return value;
}
function requireSession(db: Database.Database, sessionId: string): void {
  const row = db.prepare("SELECT id FROM sessions WHERE id=?").get(sessionId);
  if (row === undefined) {
    throw new RepositoryNotFoundError(`session ${sessionId} not found`);
  }
}
function requireText(value: unknown, what: string, max = 8192): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError(`${what} must be 1..${max} chars`);
  }
  return value;
}
function normalizeList(
  value: readonly string[],
  what: string,
  min: number,
  max: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RepositoryValidationError(
      `${what} must carry ${min}..${max} entries`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const entry = requireText(raw, what, 1024);
    if (seen.has(entry)) {
      throw new RepositoryValidationError(`${what} must be unique`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
function normalizeLiteralPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("*") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "..")
  ) {
    throw new RepositoryValidationError("path must be a canonical literal");
  }
  return value;
}
function normalizePaths(
  value: readonly string[],
  what: string,
  min = 1,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_PATHS) {
    throw new RepositoryValidationError(
      `${what} must carry ${min}..${MAX_PATHS}`,
    );
  }
  const paths = value.map(normalizeLiteralPath);
  if (new Set(paths).size !== paths.length) {
    throw new RepositoryValidationError(`${what} must be unique`);
  }
  return paths;
}
function pathInScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) => scope === "." || path === scope || path.startsWith(`${scope}/`),
  );
}
function validateCaps(raw: PolicyCaps, limits: PolicyCaps): PolicyCaps {
  const integer = (value: unknown, min: number, max: number): number => {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new RepositoryValidationError("policy caps are invalid");
    }
    return value;
  };
  const caps: PolicyCaps = Object.freeze({
    timeoutMs: integer(raw?.timeoutMs, 1000, limits.timeoutMs),
    maxOutputBytes: integer(raw?.maxOutputBytes, 1024, limits.maxOutputBytes),
    maxModelCalls: integer(raw?.maxModelCalls, 1, limits.maxModelCalls),
    maxOutputTokens: integer(raw?.maxOutputTokens, 1, limits.maxOutputTokens),
    perCallTimeoutMs: integer(
      raw?.perCallTimeoutMs,
      100,
      limits.perCallTimeoutMs,
    ),
    maxRequestBytes: integer(
      raw?.maxRequestBytes,
      1024,
      limits.maxRequestBytes,
    ),
    maxResponseBytes: integer(
      raw?.maxResponseBytes,
      1024,
      limits.maxResponseBytes,
    ),
    maxConcurrent: integer(raw?.maxConcurrent, 1, limits.maxConcurrent),
    jobsPerDay: integer(raw?.jobsPerDay, 1, limits.jobsPerDay),
    concurrentExecutions: integer(
      raw?.concurrentExecutions,
      1,
      limits.concurrentExecutions,
    ),
  });
  return caps;
}
function confirmLimits(
  policy: { checks: readonly string[]; operations: readonly TrialOperation[] },
  limits: AutodispatchLimits,
): void {
  if (policy.checks.length !== limits.checks.length) {
    throw new RepositoryValidationError("policy checks do not match operator");
  }
  const want = new Set(limits.checks);
  if (!policy.checks.every((entry) => want.has(entry))) {
    throw new RepositoryValidationError("policy checks do not match operator");
  }
  const allowed = new Set(limits.operations);
  if (!policy.operations.every((entry) => allowed.has(entry))) {
    throw new RepositoryValidationError(
      "policy operation is not allowed by operator",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Intent / conversation anchors (host validation, never model trust)  */
/* ------------------------------------------------------------------ */

interface TurnAnchorRow {
  readonly id: string;
  readonly seq: number;
  readonly input_json: string;
}

function readTurnText(row: TurnAnchorRow): string | null {
  try {
    const parsed = JSON.parse(row.input_json) as {
      kind?: unknown;
      text?: unknown;
    };
    if (parsed.kind !== "user_text" || typeof parsed.text !== "string") {
      return null;
    }
    return parsed.text;
  } catch {
    return null;
  }
}

/** A human policy anchor MUST be a real same-session `user_text` turn. A
 * random UUID, a run/session id, an assistant turn, or another session's
 * turn can never become the trusted purpose ancestry. */
function requireOwnedUserTextTurn(
  db: Database.Database,
  sessionId: string,
  turnId: string,
): void {
  requireUuid(turnId, "sourceTurnId");
  const turn = db
    .prepare(
      "SELECT id, seq, input_json FROM turns WHERE id=? AND session_id=?",
    )
    .get(turnId, sessionId) as TurnAnchorRow | undefined;
  if (turn === undefined || readTurnText(turn) === null) {
    throw new RepositoryValidationError(
      "sourceTurnId must be an owned same-session user_text turn",
    );
  }
}

function latestUserTurn(
  db: Database.Database,
  sessionId: string,
): TurnAnchorRow | null {
  return (
    (db
      .prepare(
        "SELECT id, seq, input_json FROM turns WHERE session_id=? AND json_extract(input_json,'$.kind')='user_text' ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId) as TurnAnchorRow | undefined) ?? null
  );
}

function selectedCompletedRun(
  db: Database.Database,
  sessionId: string,
  runId: string,
): { turnId: string; turnSeq: number } | null {
  const row = db
    .prepare(
      "SELECT r.turn_id AS turnId, t.seq AS turnSeq FROM runs r JOIN turns t ON t.id=r.turn_id JOIN turn_selections s ON s.run_id=r.id AND s.turn_id=r.turn_id WHERE r.id=? AND r.session_id=? AND r.status='completed'",
    )
    .get(runId, sessionId) as { turnId: string; turnSeq: number } | undefined;
  return row ?? null;
}

/** Host validation of a model-produced intent. Throws on any fabricated
 * quote, foreign session/turn/run, unselected run, or non-latest latest
 * anchor. Also refuses execute when the latest user text is a negation. */
export function validatePlanIntent(
  db: Database.Database,
  sessionId: string,
  raw: unknown,
): PlanIntent {
  const session = requireUuid(sessionId, "sessionId");
  requireSession(db, session);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RepositoryValidationError("intent must be an object");
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "execute" && kind !== "discuss" && kind !== "unclear") {
    throw new RepositoryValidationError("intent kind is invalid");
  }
  const latestUserTurnId = requireUuid(
    record.latestUserTurnId,
    "latestUserTurnId",
  );
  const latestUserRunId = requireUuid(
    record.latestUserRunId,
    "latestUserRunId",
  );
  const latest = latestUserTurn(db, session);
  if (latest === null || latest.id !== latestUserTurnId) {
    throw new RepositoryValidationError(
      "intent is stale: latest user turn changed",
    );
  }
  const latestRun = selectedCompletedRun(db, session, latestUserRunId);
  if (latestRun === null || latestRun.turnId !== latest.id) {
    throw new RepositoryValidationError(
      "intent is stale: selected latest run changed",
    );
  }
  const quotesRaw = record.quotes;
  if (
    !Array.isArray(quotesRaw) ||
    quotesRaw.length < 1 ||
    quotesRaw.length > 8
  ) {
    throw new RepositoryValidationError("intent quotes must carry 1..8");
  }
  const quotes: IntentQuote[] = [];
  for (const entry of quotesRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RepositoryValidationError("intent quote is invalid");
    }
    const q = entry as Record<string, unknown>;
    const turnId = requireUuid(q.turnId, "quote.turnId");
    const runId = requireUuid(q.runId, "quote.runId");
    const text = requireText(q.text, "quote.text", 2000);
    const turn = db
      .prepare(
        "SELECT id, seq, input_json FROM turns WHERE id=? AND session_id=?",
      )
      .get(turnId, session) as TurnAnchorRow | undefined;
    if (turn === undefined) {
      throw new RepositoryValidationError("intent quote turn is not owned");
    }
    if (turn.seq < latest.seq - MAX_PLAN_HISTORY_TURNS) {
      throw new RepositoryValidationError(
        "intent quote is outside bounded same-session history",
      );
    }
    const sourceText = readTurnText(turn);
    if (sourceText === null || !sourceText.includes(text)) {
      throw new RepositoryValidationError(
        "intent quote is not an exact user-text excerpt",
      );
    }
    const run = selectedCompletedRun(db, session, runId);
    if (run === null || run.turnId !== turnId) {
      throw new RepositoryValidationError(
        "intent quote run is not the selected completed run",
      );
    }
    quotes.push({ turnId, runId, text, seq: turn.seq });
  }
  // The latest accepted user decision must be represented, otherwise an old
  // decision can accidentally authorize current work.
  if (!quotes.some((q) => q.turnId === latestUserTurnId)) {
    throw new RepositoryValidationError(
      "intent quotes must include the latest user decision",
    );
  }
  const latestText = readTurnText(latest) ?? "";
  const negated =
    /(やめ|中止|やらない|しないで|取り消|不要|stop|cancel|don'?t|do not)/i.test(
      latestText,
    );
  const finalKind: IntentKind =
    kind === "execute" && negated ? "unclear" : (kind as IntentKind);
  return {
    kind: finalKind,
    quotes,
    latestUserTurnId,
    latestUserRunId,
    provenance: "user-conversation",
  };
}

/* ------------------------------------------------------------------ */
/* Policies                                                             */
/* ------------------------------------------------------------------ */

function rowToPolicy(row: Record<string, unknown>): StandingPolicyView {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    parentPurposeId: row.parent_purpose_id as string,
    workspaceAlias: row.workspace_alias as string,
    version: row.version as number,
    status: row.status as StandingPolicyStatus,
    operations: JSON.parse(row.operations_json as string) as TrialOperation[],
    readScopes: JSON.parse(row.read_scopes_json as string) as string[],
    writeScopes: JSON.parse(row.write_scopes_json as string) as string[],
    checks: JSON.parse(row.checks_json as string) as string[],
    caps: JSON.parse(row.caps_json as string) as PolicyCaps,
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

export function createStandingPolicy(
  db: Database.Database,
  sessionId: string,
  input: CreateStandingPolicyInput,
  options: {
    key: string;
    now?: number;
    limits: AutodispatchLimits;
    parent: Omit<CreatePurposeInput, "scope" | "kind" | "explicit">;
  },
): StandingPolicyView {
  const session = requireUuid(sessionId, "sessionId");
  const now = nowMs(options.now);
  requireSession(db, session);
  if (!/^[a-z0-9_-]{1,64}$/.test(input.workspaceAlias)) {
    throw new RepositoryValidationError("workspaceAlias is invalid");
  }
  const operations = [...input.operations];
  if (
    operations.length < 1 ||
    operations.some(
      (op) =>
        op !== "investigate" &&
        op !== "implement" &&
        op !== "verify" &&
        op !== "maintenance_trial",
    )
  ) {
    throw new RepositoryValidationError("policy operations are invalid");
  }
  for (const op of operations) {
    if (!options.limits.operations.includes(op)) {
      throw new RepositoryValidationError(
        "policy operation is not allowed by operator",
      );
    }
  }
  const readScopes = normalizePaths(input.readScopes, "readScopes");
  // Investigate/verify/maintenance_trial are read-only operations; only
  // `implement` consumes write scopes. An investigate-only policy may
  // therefore carry no write scopes, while any policy that can implement
  // still requires at least one canonical write scope.
  const writeScopes = normalizePaths(
    input.writeScopes,
    "writeScopes",
    operations.includes("implement") ? 1 : 0,
  );
  const checks = normalizeList(input.checks, "checks", 1, 16);
  const digits = /^[A-Za-z0-9_-]{1,64}$/;
  if (!checks.every((entry) => digits.test(entry))) {
    throw new RepositoryValidationError("checks are invalid");
  }
  if (
    checks.length !== options.limits.checks.length ||
    !checks.every((entry) => options.limits.checks.includes(entry))
  ) {
    throw new RepositoryValidationError("policy checks do not match operator");
  }
  const caps = validateCaps(input.caps, options.limits.caps);
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null) {
    const ms = parseStrictInstantMs(expiresAt);
    if (ms === undefined || ms <= now) {
      throw new RepositoryValidationError(
        "policy expiry must be in the future",
      );
    }
  }
  if (options.parent.sourceTurnId !== undefined) {
    requireOwnedUserTextTurn(db, session, options.parent.sourceTurnId);
  }
  const scope = `autodispatch:${input.workspaceAlias}`;
  const purpose = createPurpose(
    db,
    session,
    {
      ...options.parent,
      scope,
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: options.key, now },
  );
  const parentPurposeId = purpose.body.id;
  const replay = db
    .prepare(
      "SELECT * FROM autodispatch_policies WHERE session_id=? AND parent_purpose_id=?",
    )
    .get(session, parentPurposeId) as Record<string, unknown> | undefined;
  if (replay !== undefined) {
    return rowToPolicy(replay);
  }
  const id = generateId();
  db.prepare(
    "INSERT INTO autodispatch_policies (id, session_id, parent_purpose_id, workspace_alias, version, status, operations_json, read_scopes_json, write_scopes_json, checks_json, caps_json, expires_at, revoked_at, created_at, updated_at) VALUES (?,?,?,?,1,'active',?,?,?,?,?,?,NULL,?,?)",
  ).run(
    id,
    session,
    parentPurposeId,
    input.workspaceAlias,
    JSON.stringify(operations),
    JSON.stringify(readScopes),
    JSON.stringify(writeScopes),
    JSON.stringify(checks),
    JSON.stringify(caps),
    expiresAt,
    now,
    now,
  );
  return rowToPolicy(
    db
      .prepare("SELECT * FROM autodispatch_policies WHERE id=?")
      .get(id) as Record<string, unknown>,
  );
}

export function readStandingPolicy(
  db: Database.Database,
  sessionId: string,
  policyId: string,
): StandingPolicyView {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(policyId, "policyId");
  const row = db
    .prepare("SELECT * FROM autodispatch_policies WHERE id=? AND session_id=?")
    .get(id, session) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(`policy ${id} not found`);
  }
  return expireReadPolicy(db, row, nowMs());
}

function expireReadPolicy(
  db: Database.Database,
  row: Record<string, unknown>,
  now: number,
): StandingPolicyView {
  const view = rowToPolicy(row);
  if (view.status === "active" && view.expiresAt !== null) {
    const ms = parseStrictInstantMs(view.expiresAt);
    if (ms !== undefined && ms <= now) {
      db.prepare(
        "UPDATE autodispatch_policies SET status='expired', updated_at=? WHERE id=? AND status='active'",
      ).run(now, view.id);
      return rowToPolicy({
        ...row,
        status: "expired",
        updated_at: now,
      });
    }
  }
  return view;
}

export function listStandingPolicies(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): StandingPolicyView[] {
  const session = requireUuid(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), MAX_LIST);
  const rows = db
    .prepare(
      "SELECT * FROM autodispatch_policies WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
    )
    .all(session, capped) as Record<string, unknown>[];
  const now = nowMs();
  return rows.map((row) => expireReadPolicy(db, row, now));
}

export function revokeStandingPolicy(
  db: Database.Database,
  sessionId: string,
  policyId: string,
  options: { now?: number; reason?: string },
): StandingPolicyView {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(policyId, "policyId");
  const now = nowMs(options.now);
  withImmediateTx(db, () => {
    const result = db
      .prepare(
        "UPDATE autodispatch_policies SET status='revoked', revoked_at=?, updated_at=? WHERE id=? AND session_id=? AND status='active'",
      )
      .run(now, now, id, session);
    if (result.changes === 0) {
      throw new RepositoryValidationError("policy is not active");
    }
    // Plans and unclaimed reservations stop immediately. An unclaimed queued
    // grant becomes truthfully `revoked`; a claimed/running grant keeps its
    // status and records cancel_requested so the existing authority/runner
    // quiescence path remains the only terminal transition. No arbitrary PID
    // is ever killed here.
    db.prepare(
      "UPDATE autodispatch_plans SET status='superseded', updated_at=? WHERE policy_id=? AND session_id=? AND status IN ('frozen','needs_decision','discuss','blocked')",
    ).run(now, id, session);
    db.prepare(
      "UPDATE autodispatch_executions SET status='superseded', reason='policy-revoked', updated_at=? WHERE policy_id=? AND session_id=? AND status='reserved'",
    ).run(now, id, session);
    db.prepare(
      "UPDATE trial_grants SET status='revoked' WHERE status='queued' AND execution_id IN (SELECT execution_id FROM autodispatch_executions WHERE policy_id=? AND session_id=? AND execution_id IS NOT NULL)",
    ).run(id, session);
    db.prepare(
      "UPDATE trial_grants SET cancel_requested=1 WHERE status='claimed' AND execution_id IN (SELECT execution_id FROM autodispatch_executions WHERE policy_id=? AND session_id=? AND execution_id IS NOT NULL)",
    ).run(id, session);
  });
  return readStandingPolicy(db, session, id);
}

/* ------------------------------------------------------------------ */
/* Plans                                                                */
/* ------------------------------------------------------------------ */

function planHash(
  content: DispatchPlanContent,
  intent: PlanIntent,
  operation: TrialOperation,
  workspaceAlias: string,
  policyId: string,
): string {
  return canonicalJsonHash({
    schema: 1,
    policyId,
    goal: content.goal,
    decisions: content.decisions,
    nongoals: content.nongoals,
    steps: content.steps,
    acceptance: content.acceptance,
    missing: content.missing,
    relevantPaths: content.relevantPaths,
    operation,
    workspaceAlias,
    intentKind: intent.kind,
    quotes: intent.quotes.map((q) => ({
      turnId: q.turnId,
      runId: q.runId,
      text: q.text,
    })),
    latestUserTurnId: intent.latestUserTurnId,
    latestUserRunId: intent.latestUserRunId,
  });
}
function canonicalJsonHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonString(value), "utf8")
    .digest("hex");
}

function rowToPlan(row: Record<string, unknown>): DispatchPlanView {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    policyId: row.policy_id as string,
    policyVersion: row.policy_version as number,
    revision: row.revision as number,
    planHash: row.plan_hash as string,
    status: row.status as DispatchPlanStatus,
    goal: row.goal as string,
    decisions: JSON.parse(row.decisions_json as string) as string[],
    nongoals: JSON.parse(row.nongoals_json as string) as string[],
    steps: JSON.parse(row.steps_json as string) as string[],
    acceptance: JSON.parse(row.acceptance_json as string) as string[],
    missing: JSON.parse(row.missing_json as string) as string[],
    relevantPaths: JSON.parse(row.relevant_paths_json as string) as string[],
    operation: row.operation as TrialOperation,
    workspaceAlias: row.workspace_alias as string,
    intent: JSON.parse(row.intent_json as string) as PlanIntent,
    sourceTurnId: row.source_turn_id as string,
    sourceRunId: row.source_run_id as string,
    createdAt: row.created_at as number,
  };
}

export function createDispatchPlan(
  db: Database.Database,
  sessionId: string,
  input: {
    policyId: string;
    operation: TrialOperation;
    content: DispatchPlanContent;
    intent: unknown;
  },
  options: { now?: number },
): { plan: DispatchPlanView; replayed: boolean } {
  const session = requireUuid(sessionId, "sessionId");
  const policyId = requireUuid(input.policyId, "policyId");
  const now = nowMs(options.now);
  requireSession(db, session);
  const policyRow = db
    .prepare("SELECT * FROM autodispatch_policies WHERE id=? AND session_id=?")
    .get(policyId, session) as Record<string, unknown> | undefined;
  if (policyRow === undefined) {
    throw new RepositoryNotFoundError(`policy ${policyId} not found`);
  }
  const policy = expireReadPolicy(db, policyRow, now);
  if (policy.status !== "active") {
    throw new RepositoryValidationError("policy is not active");
  }
  const content: DispatchPlanContent = {
    goal: requireText(input.content.goal, "goal", 8192),
    decisions: normalizeList(input.content.decisions, "decisions", 0, 32),
    nongoals: normalizeList(input.content.nongoals, "nongoals", 0, 32),
    steps: normalizeList(input.content.steps, "steps", 0, 32),
    acceptance: normalizeList(input.content.acceptance, "acceptance", 0, 16),
    missing: normalizeList(input.content.missing, "missing", 0, 16),
    relevantPaths: normalizePaths(input.content.relevantPaths, "relevantPaths"),
  };
  if (
    input.operation !== "investigate" &&
    input.operation !== "implement" &&
    input.operation !== "verify" &&
    input.operation !== "maintenance_trial"
  ) {
    throw new RepositoryValidationError("plan operation is invalid");
  }
  if (!policy.operations.includes(input.operation)) {
    throw new RepositoryValidationError(
      "plan operation is not allowed by policy",
    );
  }
  const writeOperation = input.operation === "implement";
  const scopes = writeOperation ? policy.writeScopes : policy.readScopes;
  if (!content.relevantPaths.every((path) => pathInScope(path, scopes))) {
    throw new RepositoryValidationError("plan path is outside policy scope");
  }
  const intent = validatePlanIntent(db, session, input.intent);
  const hash = planHash(
    content,
    intent,
    input.operation,
    policy.workspaceAlias,
    policyId,
  );
  return withImmediateTx(db, () => {
    const replay = db
      .prepare(
        "SELECT * FROM autodispatch_plans WHERE session_id=? AND plan_hash=?",
      )
      .get(session, hash) as Record<string, unknown> | undefined;
    if (replay !== undefined) {
      return { plan: rowToPlan(replay), replayed: true };
    }
    const maxRow = db
      .prepare(
        "SELECT COALESCE(MAX(revision),0) AS max_revision FROM autodispatch_plans WHERE session_id=?",
      )
      .get(session) as { max_revision: number };
    const revision = (maxRow.max_revision ?? 0) + 1;
    db.prepare(
      "UPDATE autodispatch_plans SET status='superseded', updated_at=? WHERE session_id=? AND status IN ('frozen','needs_decision','discuss','blocked')",
    ).run(now, session);
    const status: DispatchPlanStatus =
      intent.kind === "execute"
        ? content.missing.length > 0
          ? "needs_decision"
          : "frozen"
        : intent.kind === "discuss"
          ? "discuss"
          : "needs_decision";
    const id = generateId();
    db.prepare(
      "INSERT INTO autodispatch_plans (id, session_id, policy_id, policy_version, revision, plan_hash, status, goal, decisions_json, nongoals_json, steps_json, acceptance_json, missing_json, relevant_paths_json, operation, workspace_alias, intent_json, source_turn_id, source_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      session,
      policyId,
      policy.version,
      revision,
      hash,
      status,
      content.goal,
      JSON.stringify(content.decisions),
      JSON.stringify(content.nongoals),
      JSON.stringify(content.steps),
      JSON.stringify(content.acceptance),
      JSON.stringify(content.missing),
      JSON.stringify(content.relevantPaths),
      input.operation,
      policy.workspaceAlias,
      JSON.stringify(intent),
      intent.latestUserTurnId,
      intent.latestUserRunId,
      now,
      now,
    );
    const row = db
      .prepare("SELECT * FROM autodispatch_plans WHERE id=?")
      .get(id) as Record<string, unknown>;
    return { plan: rowToPlan(row), replayed: false };
  });
}

export function readDispatchPlan(
  db: Database.Database,
  sessionId: string,
  planId: string,
): DispatchPlanView {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(planId, "planId");
  const row = db
    .prepare("SELECT * FROM autodispatch_plans WHERE id=? AND session_id=?")
    .get(id, session) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(`plan ${id} not found`);
  }
  return rowToPlan(row);
}

export function listDispatchPlans(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): DispatchPlanView[] {
  const session = requireUuid(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), MAX_LIST);
  const rows = db
    .prepare(
      "SELECT * FROM autodispatch_plans WHERE session_id=? ORDER BY revision DESC LIMIT ?",
    )
    .all(session, capped) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}

/* ------------------------------------------------------------------ */
/* Execution ledger + host authorization                                */
/* ------------------------------------------------------------------ */

function materializationSummary(
  raw: unknown,
): DispatchMaterializationSummary | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const profile = rec.profile;
  const state = rec.state;
  const digests = rec.digests;
  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile) ||
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state) ||
    typeof digests !== "object" ||
    digests === null ||
    Array.isArray(digests)
  ) {
    return null;
  }
  const p = profile as Record<string, unknown>;
  const st = state as Record<string, unknown>;
  const d = digests as Record<string, unknown>;
  const sha256 = (value: unknown): string | null =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
  const sha1 = (value: unknown): string | null =>
    typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
  const configFingerprint = sha256(p.configFingerprint);
  const sourceRevision = sha1(p.sourceRevision);
  const sourceManifestDigest = sha256(st.sourceManifestDigest);
  const dependencyDigest = sha256(st.dependencyDigest);
  const executorDigest = sha256(st.executorDigest);
  const materializationDigest = sha256(d.materialization);
  if (
    configFingerprint === null ||
    sourceRevision === null ||
    sourceManifestDigest === null ||
    dependencyDigest === null ||
    executorDigest === null ||
    materializationDigest === null
  ) {
    return null;
  }
  return {
    configFingerprint,
    sourceRevision,
    sourceManifestDigest,
    dependencyDigest,
    executorDigest,
    materializationDigest,
  };
}

function rowToExecution(row: Record<string, unknown>): DispatchExecutionView {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    planId: row.plan_id as string,
    policyId: row.policy_id as string,
    policyVersion: row.policy_version as number,
    status: row.status as DispatchExecutionStatus,
    reason: (row.reason as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    executionId: (row.execution_id as string | null) ?? null,
    dependencyDigest: (row.dependency_digest as string | null) ?? null,
    materialization: materializationSummary(row.materialization_json),
    createdAt: row.created_at as number,
  };
}

export function listDispatchExecutions(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): DispatchExecutionView[] {
  const session = requireUuid(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), MAX_LIST);
  const rows = db
    .prepare(
      "SELECT * FROM autodispatch_executions WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
    )
    .all(session, capped) as Record<string, unknown>[];
  return rows.map(rowToExecution);
}

export function readDispatchExecution(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): DispatchExecutionView {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(executionId, "executionId");
  const row = db
    .prepare(
      "SELECT * FROM autodispatch_executions WHERE id=? AND session_id=?",
    )
    .get(id, session) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(`dispatch ${id} not found`);
  }
  return rowToExecution(row);
}

/** Internal trusted-host read of the persisted per-execution materialization
 * reference. Returns the private JSON for the runner/verifier only; public
 * HTTP reads use readDispatchExecution (summary) instead. */
export function readDispatchMaterialization(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): {
  readonly executionId: string;
  readonly planId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: DispatchExecutionStatus;
  readonly digest: string | null;
  readonly materializationJson: string | null;
} | null {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(executionId, "executionId");
  const row = db
    .prepare(
      "SELECT * FROM autodispatch_executions WHERE execution_id=? AND session_id=?",
    )
    .get(id, session) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    executionId: id,
    planId: row.plan_id as string,
    policyId: row.policy_id as string,
    policyVersion: row.policy_version as number,
    status: row.status as DispatchExecutionStatus,
    digest:
      typeof row.materialization_digest === "string"
        ? row.materialization_digest
        : null,
    materializationJson:
      typeof row.materialization_json === "string"
        ? row.materialization_json
        : null,
  };
}

function deny(
  db: Database.Database,
  sessionId: string,
  plan: DispatchPlanView,
  policy: StandingPolicyView,
  dedupKey: string,
  reason: string,
  now: number,
): DispatchExecutionView {
  const id = generateId();
  db.prepare(
    "INSERT INTO autodispatch_executions (id, session_id, plan_id, policy_id, policy_version, dedup_key, status, reason, task_id, execution_id, dependency_digest, created_at, updated_at) VALUES (?,?,?,?,?,?,'denied',?,NULL,NULL,?,?,?)",
  ).run(
    id,
    sessionId,
    plan.id,
    policy.id,
    policy.version,
    dedupKey,
    reason,
    null,
    now,
    now,
  );
  return rowToExecution(
    db
      .prepare("SELECT * FROM autodispatch_executions WHERE id=?")
      .get(id) as Record<string, unknown>,
  );
}

function dayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Trusted-host authorizeWithinPolicy. The model/plan cannot call this and
 * cannot choose a path/profile/exec/check or increase a cap. Everything is
 * re-derived from the frozen plan + active human policy + operator config.
 * Duplicate delivery is deduplicated by (plan hash, revision, policy version,
 * alias, operation) under a UNIQUE key; a crash leaves an honest reservation.
 */
export function authorizeWithinPolicy(
  db: Database.Database,
  sessionId: string,
  planId: string,
  options: AuthorizeWithinPolicyOptions,
): { execution: DispatchExecutionView; replayed: boolean } {
  const session = requireUuid(sessionId, "sessionId");
  const id = requireUuid(planId, "planId");
  const now = nowMs(options.now);
  requireSession(db, session);
  if (!/^[a-z0-9_-]{1,64}$/.test(options.workspaceAlias)) {
    throw new RepositoryValidationError("workspaceAlias is invalid");
  }
  const plan = readDispatchPlan(db, session, id);
  const policy = readStandingPolicy(db, session, plan.policyId);
  const dedupKey = canonicalJsonHash({
    planHash: plan.planHash,
    revision: plan.revision,
    policyId: policy.id,
    policyVersion: policy.version,
    alias: options.workspaceAlias,
    operation: plan.operation,
    dependencyDigest: options.dependencyDigest ?? null,
    materializationDigest: options.materializationDigest ?? null,
  });
  const existing = db
    .prepare(
      "SELECT * FROM autodispatch_executions WHERE session_id=? AND dedup_key=?",
    )
    .get(session, dedupKey) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    return { execution: rowToExecution(existing), replayed: true };
  }
  if (policy.status !== "active") {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "policy-inactive",
        now,
      ),
      replayed: false,
    };
  }
  if (plan.status !== "frozen") {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        `plan-${plan.status}`,
        now,
      ),
      replayed: false,
    };
  }
  if (plan.policyVersion !== policy.version) {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "policy-version",
        now,
      ),
      replayed: false,
    };
  }
  // Stale revision: a newer plan/turn exists or the accepted turn/run changed.
  const latestPlan = db
    .prepare(
      "SELECT id, revision FROM autodispatch_plans WHERE session_id=? AND status NOT IN ('superseded') ORDER BY revision DESC LIMIT 1",
    )
    .get(session) as { id: string; revision: number } | undefined;
  if (latestPlan === undefined || latestPlan.id !== plan.id) {
    return {
      execution: deny(db, session, plan, policy, dedupKey, "plan-stale", now),
      replayed: false,
    };
  }
  try {
    validatePlanIntent(db, session, plan.intent);
  } catch {
    return {
      execution: deny(db, session, plan, policy, dedupKey, "intent-stale", now),
      replayed: false,
    };
  }
  const control = db
    .prepare("SELECT paused FROM autonomy_control WHERE id='global'")
    .get() as { paused: number } | undefined;
  if (control === undefined || control.paused === 1) {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "control-paused",
        now,
      ),
      replayed: false,
    };
  }
  if (plan.workspaceAlias !== options.workspaceAlias) {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "alias-mismatch",
        now,
      ),
      replayed: false,
    };
  }
  try {
    confirmLimits(policy, options.limits);
  } catch {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "operator-limits",
        now,
      ),
      replayed: false,
    };
  }
  if (!options.limits.operations.includes(plan.operation)) {
    return {
      execution: deny(
        db,
        session,
        plan,
        policy,
        dedupKey,
        "operation-not-allowed",
        now,
      ),
      replayed: false,
    };
  }
  // The policy caps are UPPER BOUNDS. The grant request budget is the
  // narrower of the policy cap and the ACTUAL materialized operator profile,
  // never widened back to the policy maximum (a narrower runtime unit would
  // otherwise disagree with the observed permit bound).
  const appliedTimeoutMs = Math.min(
    policy.caps.timeoutMs,
    options.profile.timeoutMs,
  );
  const appliedMaxOutputBytes = Math.min(
    policy.caps.maxOutputBytes,
    options.profile.maxOutputBytes,
  );
  if (
    options.profile.timeoutMs < 1000 ||
    options.profile.maxOutputBytes < 1024 ||
    options.profile.mandatoryChecks.length !== policy.checks.length ||
    !policy.checks.every((c) => options.profile.mandatoryChecks.includes(c))
  ) {
    return {
      execution: deny(db, session, plan, policy, dedupKey, "profile-caps", now),
      replayed: false,
    };
  }
  // Quota + reservation share ONE BEGIN IMMEDIATE transaction, so separate
  // SQLite connections serialize here instead of both observing a free slot.
  // `reserved` rows count as already-spent daily slots and as concurrent
  // grants (they have no trial grant yet) to close the reserve-to-authorize
  // window across connections.
  const reservationId =
    options.executionId === undefined
      ? generateId()
      : requireUuid(options.executionId, "executionId");
  if (
    options.materializationDigest !== undefined &&
    !/^[0-9a-f]{64}$/.test(options.materializationDigest)
  ) {
    throw new RepositoryValidationError(
      "materializationDigest must be 64 lower-hex chars",
    );
  }
  const reserved = withImmediateTx(
    db,
    ():
      | { reserved: true; row: Record<string, unknown> }
      | { reserved: false; row: Record<string, unknown> }
      | { reserved: false; quotaReason: string } => {
      const again = db
        .prepare(
          "SELECT * FROM autodispatch_executions WHERE session_id=? AND dedup_key=?",
        )
        .get(session, dedupKey) as Record<string, unknown> | undefined;
      if (again !== undefined) return { reserved: false, row: again };
      const usedToday = db
        .prepare(
          "SELECT COUNT(*) AS count FROM autodispatch_executions WHERE session_id=? AND policy_id=? AND status IN ('reserved','authorized') AND created_at>=?",
        )
        .get(session, policy.id, dayStart(now)) as { count: number };
      if (usedToday.count >= policy.caps.jobsPerDay) {
        return { reserved: false, quotaReason: "quota-daily" };
      }
      const activeCount = db
        .prepare(
          "SELECT COUNT(*) AS count FROM autodispatch_executions e LEFT JOIN trial_grants g ON g.execution_id=e.execution_id WHERE e.session_id=? AND e.policy_id=? AND (e.status='reserved' OR (e.status='authorized' AND g.status IN ('queued','claimed')))",
        )
        .get(session, policy.id) as { count: number };
      if (activeCount.count >= policy.caps.concurrentExecutions) {
        return { reserved: false, quotaReason: "quota-concurrent" };
      }
      db.prepare(
        "INSERT INTO autodispatch_executions (id, session_id, plan_id, policy_id, policy_version, dedup_key, status, reason, task_id, execution_id, dependency_digest, materialization_json, materialization_digest, created_at, updated_at) VALUES (?,?,?,?,?,?,'reserved',NULL,NULL,NULL,?,?,?,?,?)",
      ).run(
        reservationId,
        session,
        plan.id,
        policy.id,
        policy.version,
        dedupKey,
        options.dependencyDigest ?? null,
        options.materialization === undefined
          ? null
          : JSON.stringify(options.materialization),
        options.materializationDigest ?? null,
        now,
        now,
      );
      return {
        reserved: true,
        row: db
          .prepare("SELECT * FROM autodispatch_executions WHERE id=?")
          .get(reservationId) as Record<string, unknown>,
      };
    },
  );
  if (!reserved.reserved) {
    if ("quotaReason" in reserved) {
      return {
        execution: deny(
          db,
          session,
          plan,
          policy,
          dedupKey,
          reserved.quotaReason,
          now,
        ),
        replayed: false,
      };
    }
    return { execution: rowToExecution(reserved.row), replayed: true };
  }
  try {
    const taskInput: CreateTaskInput = {
      scope: `autodispatch:${policy.workspaceAlias}`,
      title: plan.goal.slice(0, 256),
      body: [
        `goal: ${plan.goal}`,
        `policy: ${policy.id} v${policy.version}`,
        `plan: ${plan.id} r${plan.revision} ${plan.planHash}`,
        `source turn/run: ${plan.sourceTurnId} / ${plan.sourceRunId}`,
        ...(options.dependencyDigest !== undefined
          ? [`dependencies: ${options.dependencyDigest}`]
          : []),
      ].join("\n"),
      kind: "task",
      speaker: "self",
      parentPurposeId: policy.parentPurposeId,
    };
    const task = createTask(db, session, taskInput, {
      key: generateId(),
      now,
    });
    const writeOperation = plan.operation === "implement";
    // Read-only grants must still carry the plan's frozen relevant paths (the
    // operator-approved scope the materialized profile allows); falling back
    // to whole-repo "." made the wire request fall outside that profile and
    // the bridge rejected every investigate launch. Only an empty plan path
    // list falls back to ".". Write grants are unchanged.
    const paths =
      plan.relevantPaths.length > 0 ? [...plan.relevantPaths] : ["."];
    const expiry = new Date(now + appliedTimeoutMs + 60_000).toISOString();
    const grantInput: PolicyGrantInput = {
      taskId: task.body.id,
      objective: plan.goal,
      acceptance:
        plan.acceptance.length > 0 ? [...plan.acceptance] : [plan.goal],
      literalPatchPaths: paths,
      operation: plan.operation,
      readOnlyMode: !writeOperation,
      expiry,
      // Auto dispatch supports ONLY frozen local/synthetic-local model
      // routes. Consent for possible external data must therefore stay
      // false even for write operations: writing is authorized by the
      // policy/plan/write scopes, not by model-route consent.
      possibleExternalDataConsent: false,
      timeoutMs: appliedTimeoutMs,
      maxOutputBytes: appliedMaxOutputBytes,
      requiredChecks: [...policy.checks],
      workspaceAlias: policy.workspaceAlias,
    };
    const grant = derivePolicyTrialGrant(db, session, grantInput, {
      now,
      profile: options.profile,
      workspaceAlias: options.workspaceAlias,
      executionId: reservationId,
    });
    // Persist the link atomically after the existing authority created the
    // one-use grant. The grant owner keeps claim/launch/result/quiescence.
    withImmediateTx(db, () => {
      db.prepare(
        "UPDATE autodispatch_executions SET status='authorized', task_id=?, execution_id=?, updated_at=? WHERE id=? AND status='reserved'",
      ).run(task.body.id, grant.executionId, now, reservationId);
      db.prepare(
        "UPDATE autodispatch_plans SET status='dispatched', updated_at=? WHERE id=? AND status='frozen'",
      ).run(now, plan.id);
    });
    const row = db
      .prepare("SELECT * FROM autodispatch_executions WHERE id=?")
      .get(reservationId) as Record<string, unknown>;
    return { execution: rowToExecution(row), replayed: false };
  } catch (error) {
    const reason =
      error instanceof RepositoryValidationError
        ? "authority-rejected"
        : "authority-error";
    db.prepare(
      "UPDATE autodispatch_executions SET status='blocked', reason=?, updated_at=? WHERE id=? AND status='reserved'",
    ).run(reason, now, reservationId);
    throw error;
  }
}

/** Local re-export used by callers that want the same strict instant check. */
export function isValidPolicyExpiry(value: unknown): boolean {
  return typeof value === "string" && parseStrictInstantMs(value) !== undefined;
}

/* ------------------------------------------------------------------ */
/* Bounded same-session user intent context (no raw/tool/other logs)   */
/* ------------------------------------------------------------------ */

export interface IntentHistoryEntry {
  readonly turnId: string;
  readonly runId: string;
  readonly seq: number;
  readonly text: string;
}

export interface IntentHistory {
  readonly latestUserTurnId: string;
  readonly latestUserRunId: string;
  readonly entries: readonly IntentHistoryEntry[];
}

/**
 * Bounded, same-session, selected completed user_text history. Tool results,
 * assistant prose, frozen context, other sessions, and raw logs are never
 * returned. Returns null when the latest user turn has no selected completed
 * run (nothing may be planned/dispatched from an unfinished turn).
 */
export function readIntentHistory(
  db: Database.Database,
  sessionId: string,
  limit = MAX_PLAN_HISTORY_TURNS,
): IntentHistory | null {
  const session = requireUuid(sessionId, "sessionId");
  requireSession(db, session);
  const latest = latestUserTurn(db, session);
  if (latest === null) return null;
  const latestRun = db
    .prepare(
      "SELECT s.run_id AS runId FROM turn_selections s WHERE s.turn_id=?",
    )
    .get(latest.id) as { runId: string } | undefined;
  if (latestRun === undefined) return null;
  if (selectedCompletedRun(db, session, latestRun.runId) === null) return null;
  const capped = Math.min(Math.max(limit, 1), MAX_PLAN_HISTORY_TURNS);
  const turns = db
    .prepare(
      "SELECT id, seq, input_json FROM turns WHERE session_id=? AND json_extract(input_json,'$.kind')='user_text' ORDER BY seq DESC LIMIT ?",
    )
    .all(session, capped) as TurnAnchorRow[];
  const entries: IntentHistoryEntry[] = [];
  for (const turn of turns) {
    const text = readTurnText(turn);
    if (text === null) continue;
    const selection = db
      .prepare(
        "SELECT s.run_id AS runId FROM turn_selections s JOIN runs r ON r.id=s.run_id WHERE s.turn_id=? AND r.status='completed'",
      )
      .get(turn.id) as { runId: string } | undefined;
    if (selection === undefined) continue;
    entries.push({
      turnId: turn.id,
      runId: selection.runId,
      seq: turn.seq,
      text,
    });
  }
  return {
    latestUserTurnId: latest.id,
    latestUserRunId: latestRun.runId,
    entries,
  };
}

/** Trusted run -> session lookup for the durable completion intake hook. */
export function readRunSessionId(
  db: Database.Database,
  runId: string,
): string | null {
  const id = requireUuid(runId, "runId");
  const row = db.prepare("SELECT session_id FROM runs WHERE id=?").get(id) as
    | { session_id: string }
    | undefined;
  return row?.session_id ?? null;
}
