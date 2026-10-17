// Schema12 AUTONOMY TRIAL AUTHORITY domain (leaf module: no autonomy.ts
// import, to avoid an autonomy->trials->autonomy cycle; direct SQL reads).
// Owner/session check BEFORE cache; cached-somebody replay BEFORE mutable
// authority/profile/state checks; body drift 409; foreign 404.
import {
  ConstraintRuleSchema,
  TrialLaunchRequestSchema,
  TrialProfileSnapshotSchema,
  TrialProposalViewSchema,
  type TrialLaunchRequest,
  type TrialOperation,
  type TrialProfileSnapshot,
  type TrialProposalView,
} from "@companion/contracts";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  generateId,
  IDEMPOTENCY_OPERATIONS,
  requestHash,
} from "./canonical.js";
import {
  IdempotencyConflictError,
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import { parseStrictInstantMs } from "./action_strategy.js";

export type { TrialProfileSnapshot };

function nowMs(input?: number): number {
  const now = input ?? Date.now();
  if (!Number.isInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new RepositoryValidationError("now must be an integer Unix-ms");
  }
  return now;
}
function parseOr<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KernelStorageError) throw e;
    throw new RepositoryValidationError(`${what}: ${(e as Error).message}`, {
      cause: e,
    });
  }
}
function requireKey(k: unknown): string {
  const s = typeof k === "string" ? k.toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s))
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  return s;
}
function requireId(id: unknown, what: string): string {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  return id;
}
function withImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const o = fn();
    db.exec("COMMIT");
    return o;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch { /* noop */ }
    throw e;
  }
}
function stored(db: Database.Database, scope: string, key: string) {
  const row = db
    .prepare("SELECT request_hash, response_status, response_body FROM api_idempotency WHERE scope=? AND key=?")
    .get(scope, key) as { request_hash: string; response_status: number; response_body: string } | undefined;
  if (!row) return null;
  return {
    requestHash: row.request_hash,
    status: row.response_status,
    body: parseOr(() => JSON.parse(row.response_body), "stored idempotency body"),
  };
}
function store(db: Database.Database, scope: string, key: string, hash: string, status: number, body: unknown, now: number) {
  db.prepare("INSERT INTO api_idempotency (scope,key,request_hash,response_status,response_body,created_at) VALUES (?,?,?,?,?,?)").run(
    scope, key, hash, status, JSON.stringify(body), now,
  );
}
function requireSession(db: Database.Database, s: string) {
  const r = db.prepare("SELECT id FROM sessions WHERE id=?").get(s) as { id: string } | undefined;
  if (!r) throw new RepositoryNotFoundError(`session ${s} not found`);
}

/** Strict rule validation: unknown/corrupt fails closed. */
export function parseConstraintRule(value: unknown): { denyWorkspace: string[]; denyOperation: TrialOperation[]; denyWritePath: { workspaceAlias: string; literalPrefix: string }[] } {
  return parseOr(() => {
    const r = ConstraintRuleSchema.parse(value ?? { denyWorkspace: [], denyOperation: [], denyWritePath: [] });
    for (const p of r.denyWritePath) {
      if (p.literalPrefix.includes("*") || p.literalPrefix.includes("?"))
        throw new Error("deny_write_path literalPrefix must be literal (no globs)");
      if (p.literalPrefix.length > 1 && p.literalPrefix.endsWith("/"))
        throw new Error("deny_write_path literalPrefix must not end with /");
    }
    return r;
  }, "constraintRule");
}

/** Literal path scope check: ancestor+descendant intersect => blocked. */
export function pathIntersectsDenied(writePath: string, prefix: string): boolean {
  if (prefix === ".") return true;
  const n = (p: string) => p.replace(/\/+$/, "");
  const w = n(writePath);
  const d = n(prefix);
  return w === d || w.startsWith(d + "/") || d.startsWith(w + "/");
}

interface PurposeRow { id: string; session_id: string; scope: string; kind: string; is_explicit: number; source_kind: string; status: string; version: number; valid_from: string | null; valid_until: string | null; }
interface TaskRow { id: string; session_id: string; scope: string; kind: string; status: string; version: number; parent_purpose_id: string | null; }

function applicable(row: PurposeRow, now: number): boolean {
  if (row.valid_from !== null && Date.parse(row.valid_from) > now) return false;
  if (row.valid_until !== null && now >= Date.parse(row.valid_until)) return false;
  return true;
}
function activeConstraints(db: Database.Database, session: string, scope: string): { rule: ReturnType<typeof parseConstraintRule>; unstructured: boolean }[] {
  const out: { rule: ReturnType<typeof parseConstraintRule>; unstructured: boolean }[] = [];
  const rows = db.prepare("SELECT purpose_id, rule_json FROM trial_constraint_rules WHERE session_id=? AND scope=?").all(session, scope) as { purpose_id: string; rule_json: string | null }[];
  // Unstructured authoritative constraints: any active kind=constraint
  // purpose in scope WITHOUT a structured rule HOLDS (fail-closed listing).
  const active = db.prepare("SELECT id FROM autonomy_purposes WHERE session_id=? AND scope=? AND kind='constraint' AND status='active'").all(session, scope) as { id: string }[];
  const withRule = new Set(rows.map((r) => r.purpose_id));
  for (const a of active) {
    if (!withRule.has(a.id)) out.push({ rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] }, unstructured: true });
  }
  for (const r of rows) {
    // Only count rules whose purpose is still active.
    const p = db.prepare("SELECT status FROM autonomy_purposes WHERE id=?").get(r.purpose_id) as { status: string } | undefined;
    if (!p || p.status !== "active") continue;
    if (r.rule_json === null) {
      out.push({ rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] }, unstructured: true });
    } else {
      try {
        out.push({ rule: parseConstraintRule(JSON.parse(r.rule_json)), unstructured: false });
      } catch {
        out.push({ rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] }, unstructured: true });
      }
    }
  }
  return out;
}

/**
 * AUTHORITY: owned kind=task non-held/non-terminal task with same-scope
 * active applicable parent kind=goal sourceKind=user explicit=true.
 * Owner-recorded conflict involving the goal HOLDS. Unstructured constraint
 * HOLDS. Structured rules: deny_workspace/deny_operation/deny_write_path.
 * Returns {allowed, goalId, goalVersion} or throws 404/409.
 */
export function checkTrialAuthority(
  db: Database.Database, sessionId: string, taskId: string,
  operation: TrialOperation, writePaths: string[], workspaceAlias: string, now: number,
): { goalId: string; goalVersion: number; taskVersion: number; scope: string } {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  const t = db.prepare("SELECT * FROM autonomy_tasks WHERE id=?").get(task) as TaskRow | undefined;
  if (!t || t.session_id !== session) throw new RepositoryNotFoundError(`task ${task} not found in session ${session}`);
  if (t.kind !== "task") throw new RepositoryValidationError("authority requires kind=task");
  if (t.status === "held" || t.status === "completed" || t.status === "cancelled")
    throw new RepositoryValidationError(`task ${t.id} is ${t.status}: no authority`);
  if (t.parent_purpose_id === null) throw new RepositoryValidationError("task has no parent goal");
  const g = db.prepare("SELECT * FROM autonomy_purposes WHERE id=?").get(t.parent_purpose_id) as PurposeRow | undefined;
  if (!g || g.session_id !== session || g.kind !== "goal" || g.scope !== t.scope)
    throw new RepositoryNotFoundError(`parent goal not found in session ${session}`);
  if (g.status !== "active" || !applicable(g, nowMs(now)))
    throw new RepositoryValidationError(`parent goal is not active/applicable`);
  if (g.source_kind !== "user" || g.is_explicit !== 1)
    throw new RepositoryValidationError("authority requires explicit user goal");
  // self/external claims never authority even explicit=true: task speaker
  // is not consulted here beyond kind; goal provenance is decisive.
  // Owner-recorded conflict involving goal HOLDS even other member external.
  const conflict = db.prepare(
    "SELECT 1 FROM autonomy_purpose_conflicts c JOIN autonomy_purposes pa ON pa.id=c.purpose_a_id JOIN autonomy_purposes pb ON pb.id=c.purpose_b_id WHERE c.session_id=? AND (c.purpose_a_id=? OR c.purpose_b_id=?) AND pa.status='active' AND pb.status='active' LIMIT 1",
  ).get(session, g.id, g.id);
  if (conflict) throw new RepositoryValidationError("goal is in recorded conflict: authority held");
  // Constraints: unstructured HOLDS everything; structured deny checks.
  const rules = activeConstraints(db, session, t.scope);
  for (const c of rules) {
    if (c.unstructured) throw new RepositoryValidationError("unstructured authoritative constraint holds");
  }
  for (const c of rules) {
    if (c.rule.denyWorkspace.includes(workspaceAlias))
      throw new RepositoryValidationError(`workspace ${workspaceAlias} denied`);
    if ((c.rule.denyOperation as string[]).includes(operation))
      throw new RepositoryValidationError(`operation ${operation} denied`);
    for (const d of c.rule.denyWritePath) {
      if (d.workspaceAlias !== workspaceAlias) continue;
      for (const w of writePaths) {
        if (pathIntersectsDenied(w, d.literalPrefix))
          throw new RepositoryValidationError(`write path ${w} denied under ${d.literalPrefix}`);
      }
    }
  }
  if ((operation === "investigate" || operation === "verify") && writePaths.length > 0)
    throw new RepositoryValidationError(`${operation} is read-only`);
  return { goalId: g.id, goalVersion: g.version, taskVersion: t.version, scope: t.scope };
}

/** Deterministic launch-request hash over ALL fields except taskHash (incl execId). */
export function hashTrialRequest(req: TrialLaunchRequest): string {
  const { taskHash: _drop, ...rest } = req as TrialLaunchRequest & { taskHash: string };
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) ordered[k] = (rest as Record<string, unknown>)[k];
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export interface StageInput {
  taskId: string; objective: string; acceptance: string[]; literalPatchPaths: string[];
  operation: TrialOperation; readOnlyMode: boolean; expiry: string;
  possibleExternalDataConsent: boolean; timeoutMs: number; maxOutputBytes: number;
  requiredChecks: string[]; workspaceAlias: string;
}
export interface ClaimDeps { profile: TrialProfileSnapshot; }

function profileOrThrow(p: TrialProfileSnapshot): TrialProfileSnapshot {
  return parseOr(() => TrialProfileSnapshotSchema.parse(p), "profile snapshot");
}

/** Stage DATA-only proposal (authority checked, frozen versions). */
export function stageTrialProposal(db: Database.Database, sessionId: string, input: StageInput, options: { key: string; now?: number }): { status: number; body: TrialProposalView; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:trial-stage`;
  const hash = requestHash(IDEMPOTENCY_OPERATIONS.stageTrial.operation, IDEMPOTENCY_OPERATIONS.stageTrial.schemaVersion, {
    sessionId: session, ...input,
  });
  return withImmediate(db, () => {
    requireSession(db, session);
    const ex = stored(db, scope, key);
    if (ex) {
      if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
      return { status: ex.status, body: parseOr(() => TrialProposalViewSchema.parse(ex.body), "stored proposal"), replayed: true };
    }
    if (parseStrictInstantMs(input.expiry) === undefined)
      throw new RepositoryValidationError("expiry must be strict RFC3339 instant");
    if (Date.parse(input.expiry) <= now) throw new RepositoryValidationError("proposal already expired");
    const auth = checkTrialAuthority(db, session, input.taskId, input.operation, input.readOnlyMode ? [] : input.literalPatchPaths, input.workspaceAlias, now);
    if (input.readOnlyMode !== (input.operation === "investigate" || input.operation === "verify")) {
      // readOnlyMode must match closed read-only ops explicitly.
      throw new RepositoryValidationError("readOnlyMode must match read-only operation");
    }
    if (!input.possibleExternalDataConsent && input.operation === "implement")
      throw new RepositoryValidationError("external data consent decision required");
    const id = generateId();
    db.prepare("INSERT INTO trial_proposals (id, session_id, scope, task_id, goal_id, goal_version, task_version, objective, acceptance_json, paths_json, operation, read_only, expiry, consent, timeout_ms, max_output_bytes, checks_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, session, auth.scope, input.taskId, auth.goalId, auth.goalVersion, auth.taskVersion,
      input.objective, JSON.stringify(input.acceptance), JSON.stringify(input.literalPatchPaths),
      input.operation, input.readOnlyMode ? 1 : 0, input.expiry, input.possibleExternalDataConsent ? 1 : 0,
      input.timeoutMs, input.maxOutputBytes, JSON.stringify(input.requiredChecks), "staged", now,
    );
    const body = parseOr(() => TrialProposalViewSchema.parse({
      id, sessionId: session, scope: auth.scope, taskId: input.taskId, goalId: auth.goalId,
      goalVersion: auth.goalVersion, taskVersion: auth.taskVersion, objective: input.objective,
      acceptance: input.acceptance, literalPatchPaths: input.literalPatchPaths, operation: input.operation,
      readOnlyMode: input.readOnlyMode, expiry: input.expiry,
      possibleExternalDataConsent: input.possibleExternalDataConsent, timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes, requiredChecks: input.requiredChecks, status: "staged", createdAt: now,
    }), "proposal view");
    store(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export function listTrialProposals(db: Database.Database, sessionId: string, limit = 50): { items: TrialProposalView[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db.prepare("SELECT * FROM trial_proposals WHERE session_id=? ORDER BY created_at DESC LIMIT ?").all(session, capped) as Parameters<typeof toProposalView>[0][];
  return { items: rows.map((r) => toProposalView(r)) };
}
function toProposalView(r: { id: string; session_id: string; scope: string; task_id: string; goal_id: string | null; goal_version: number | null; task_version: number; objective: string; acceptance_json: string; paths_json: string; operation: string; read_only: number; expiry: string; consent: number; timeout_ms: number; max_output_bytes: number; checks_json: string; status: string; created_at: number }): TrialProposalView {
  return parseOr(() => TrialProposalViewSchema.parse({
    id: r.id, sessionId: r.session_id, scope: r.scope, taskId: r.task_id, goalId: r.goal_id,
    goalVersion: r.goal_version, taskVersion: r.task_version, objective: r.objective,
    acceptance: JSON.parse(r.acceptance_json), literalPatchPaths: JSON.parse(r.paths_json),
    operation: r.operation, readOnlyMode: r.read_only === 1, expiry: r.expiry,
    possibleExternalDataConsent: r.consent === 1, timeoutMs: r.timeout_ms,
    maxOutputBytes: r.max_output_bytes, requiredChecks: JSON.parse(r.checks_json),
    status: r.status, createdAt: r.created_at,
  }), "proposal row");
}

/** Approve: fresh goal/task/constraints/profile/expiry/unpaused checks; one grant. */
export function approveTrialProposal(db: Database.Database, sessionId: string, proposalId: string, options: { key: string; now?: number; profile: TrialProfileSnapshot; workspaceAlias: string }): { status: number; body: { executionId: string; proposalId: string; sessionId: string; scope: string; status: string; cancelRequested: boolean; controlGeneration: number; createdAt: number }; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const pid = requireId(proposalId, "proposalId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  const scope = `trial-proposal:${pid}`;
  return withImmediate(db, () => {
    const prow = db.prepare("SELECT * FROM trial_proposals WHERE id=?").get(pid) as Parameters<typeof toProposalView>[0] | undefined;
    if (!prow || (prow as { session_id: string }).session_id !== session)
      throw new RepositoryNotFoundError(`proposal ${pid} not found in session ${session}`);
    const hash = requestHash(IDEMPOTENCY_OPERATIONS.approveTrial.operation, IDEMPOTENCY_OPERATIONS.approveTrial.schemaVersion, {
      sessionId: session, proposalId: pid,
    });
    const ex = stored(db, scope, key);
    if (ex) {
      if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
      return { status: ex.status, body: ex.body as { executionId: string; proposalId: string; sessionId: string; scope: string; status: string; cancelRequested: boolean; controlGeneration: number; createdAt: number }, replayed: true };
    }
    // UNIQUE(proposal_id) prevents different-keys double approve.
    const prior = db.prepare("SELECT execution_id FROM trial_grants WHERE proposal_id=?").get(pid) as { execution_id: string } | undefined;
    if (prior) throw new RepositoryValidationError("proposal already granted (one grant per approval)");
    const view = toProposalView(prow);
    if (view.status !== "staged") throw new RepositoryValidationError(`proposal is ${view.status}`);
    if (Date.parse(view.expiry) <= now) {
      db.prepare("UPDATE trial_proposals SET status='expired' WHERE id=?").run(pid);
      throw new RepositoryValidationError("proposal expired");
    }
    if (!profile.available || !profile.enabled) throw new RepositoryValidationError("profile unavailable: no new grant");
    if (!profile.disclosedWholeRepoRead) throw new RepositoryValidationError("approved scope requires whole-repo READ disclosure");
    for (const m of profile.mandatoryChecks) {
      if (!view.requiredChecks.includes(m)) throw new RepositoryValidationError(`request drops mandatory check ${m}`);
    }
    const ctl = db.prepare("SELECT paused, version FROM autonomy_control WHERE id='global'").get() as { paused: number; version: number };
    if (ctl.paused === 1) throw new RepositoryValidationError("autonomy paused: no new grant");
    // Fresh authority re-check before grant.
    checkTrialAuthority(db, session, view.taskId, view.operation, view.readOnlyMode ? [] : view.literalPatchPaths, options.workspaceAlias, now);
    const executionId = generateId();
    db.prepare("INSERT INTO trial_grants (execution_id, proposal_id, session_id, scope, status, cancel_requested, control_generation, created_at) VALUES (?,?,?,?, 'queued', 0, ?, ?)").run(
      executionId, pid, session, view.scope, ctl.version, now,
    );
    db.prepare("UPDATE trial_proposals SET status='granted' WHERE id=?").run(pid);
    const body = { executionId, proposalId: pid, sessionId: session, scope: view.scope, status: "queued", cancelRequested: false, controlGeneration: ctl.version, createdAt: now };
    store(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/** Claim consumes grant + persists immutable frozen intent BEFORE provider. */
export function claimTrialGrant(db: Database.Database, sessionId: string, executionId: string, options: { key: string; now?: number; profile: TrialProfileSnapshot; workspaceAlias: string; purposeStatement: string }): { status: number; body: { kind: "replay" | "result"; grant: unknown; request: TrialLaunchRequest; applied: boolean }; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  const scope = `trial-claim:${exec}`;
  const hash = requestHash(IDEMPOTENCY_OPERATIONS.claimTrial.operation, IDEMPOTENCY_OPERATIONS.claimTrial.schemaVersion, {
    sessionId: session, executionId: exec,
  });
  return withImmediate(db, () => {
    const g = db.prepare("SELECT * FROM trial_grants WHERE execution_id=?").get(exec) as { execution_id: string; proposal_id: string; session_id: string; scope: string; status: string; cancel_requested: number; control_generation: number; created_at: number; request_json: string | null } | undefined;
    if (!g || g.session_id !== session) throw new RepositoryNotFoundError(`grant ${exec} not found in session ${session}`);
    const ex = stored(db, scope, key);
    if (ex) {
      if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
      return { status: ex.status, body: ex.body as { kind: "replay" | "result"; grant: unknown; request: TrialLaunchRequest; applied: boolean }, replayed: true };
    }
    // Claim replay: already-claimed grant returns discriminated replay, no new launch.
    if (g.request_json !== null) {
      const req = parseOr(() => TrialLaunchRequestSchema.parse(JSON.parse(g.request_json as string)), "frozen request");
      const body = { kind: "replay" as const, grant: toGrantView(g), request: req, applied: false };
      store(db, scope, key, hash, 200, body, now);
      return { status: 200, body, replayed: false };
    }
    if (g.status === "revoked" || g.status === "consumed" || g.status === "interrupted")
      throw new RepositoryValidationError(`grant is ${g.status}: never resend`);
    if (g.cancel_requested === 1) throw new RepositoryValidationError("grant cancel requested");
    const prow = db.prepare("SELECT * FROM trial_proposals WHERE id=?").get(g.proposal_id) as Parameters<typeof toProposalView>[0];
    const view = toProposalView(prow);
    if (Date.parse(view.expiry) <= now) throw new RepositoryValidationError("grant expired");
    // Bind control generation AT CLAIM; queued grants survive pause/restart
    // but can claim ONLY after fresh EXPLICIT global resume.
    const ctl = db.prepare("SELECT paused, version FROM autonomy_control WHERE id='global'").get() as { paused: number; version: number };
    if (ctl.paused === 1) throw new RepositoryValidationError("paused: fresh explicit resume required");
    if (!profile.available || !profile.enabled) throw new RepositoryValidationError("profile unavailable at claim");
    checkTrialAuthority(db, session, view.taskId, view.operation, view.readOnlyMode ? [] : view.literalPatchPaths, options.workspaceAlias, now);
    const taskHash = createHash("sha256").update(`${view.taskId}:${view.taskVersion}`).digest("hex");
    const req = parseOr(() => TrialLaunchRequestSchema.parse({
      version: 1, executionId: exec, taskHash, configFingerprint: profile.configFingerprint,
      sourceRevision: profile.sourceRevision, workspaceAlias: options.workspaceAlias, mode: view.operation,
      purpose: { statement: options.purposeStatement, scope: view.scope },
      objective: view.objective, relevantPaths: view.literalPatchPaths, acceptance: view.acceptance,
      requiredChecks: view.requiredChecks, constraints: [],
      budget: { timeoutMs: view.timeoutMs, maxOutputBytes: view.maxOutputBytes },
      externalModelConsent: view.possibleExternalDataConsent,
    }), "launch request");
    db.prepare("UPDATE trial_grants SET status='claimed', control_generation=?, request_json=?, claimed_at=? WHERE execution_id=?").run(
      ctl.version, JSON.stringify(req), now, exec,
    );
    const updated = db.prepare("SELECT * FROM trial_grants WHERE execution_id=?").get(exec) as Parameters<typeof toGrantView>[0];
    const body = { kind: "result" as const, grant: toGrantView(updated), request: req, applied: true };
    store(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}
function toGrantView(g: { execution_id: string; proposal_id: string; session_id: string; scope: string; status: string; cancel_requested: number; control_generation: number; created_at: number }): { executionId: string; proposalId: string; sessionId: string; scope: string; status: "queued" | "claimed" | "revoked" | "consumed" | "interrupted"; cancelRequested: boolean; controlGeneration: number; createdAt: number } {
  return {
    executionId: g.execution_id, proposalId: g.proposal_id, sessionId: g.session_id, scope: g.scope,
    status: g.status as "queued" | "claimed" | "revoked" | "consumed" | "interrupted",
    cancelRequested: g.cancel_requested === 1, controlGeneration: g.control_generation, createdAt: g.created_at,
  };
}

/** Invalidate affected queued+inflight grants (never revive); unrelated alias continues. */
export function invalidateTrialsForScope(db: Database.Database, sessionId: string, scope: string, reason: string, now: number): number {
  const rows = db.prepare("SELECT execution_id, status FROM trial_grants WHERE session_id=? AND scope=? AND status IN ('queued','claimed')").all(sessionId, scope) as { execution_id: string; status: string }[];
  let n = 0;
  for (const r of rows) {
    if (r.status === "queued") {
      db.prepare("UPDATE trial_grants SET status='revoked' WHERE execution_id=?").run(r.execution_id);
    } else {
      db.prepare("UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?").run(r.execution_id);
    }
    n++;
  }
  void reason;
  void now;
  return n;
}
/** STOP: pause first + revoke CLAIMED/inflight and cancelRequested. */
export function revokeAllClaimedForStop(db: Database.Database, now: number): number {
  // QUEUED-unconsumed grants SURVIVE pause/restart (claim gated on fresh
  // explicit resume); only CLAIMED inflight is revoked + cancelRequested.
  const rows = db.prepare("SELECT execution_id FROM trial_grants WHERE status='claimed'").all() as { execution_id: string }[];
  for (const r of rows) {
    db.prepare("UPDATE trial_grants SET status='revoked', cancel_requested=1 WHERE execution_id=?").run(r.execution_id);
  }
  void now;
  return rows.length;
}
/** Unknown execution fences affected alias: revoke queued + flag claimed. */
export function fenceUnknownExecution(db: Database.Database, sessionId: string, scope: string, now: number): number {
  return invalidateTrialsForScope(db, sessionId, scope, "unknown_execution_fence", now);
}
/** Explicit expire/invalidate command (pure GETs never write expiry). */
export function expireTrialProposal(db: Database.Database, sessionId: string, proposalId: string, now: number): void {
  withImmediate(db, () => {
    const p = db.prepare("SELECT session_id, status FROM trial_proposals WHERE id=?").get(proposalId) as { session_id: string; status: string } | undefined;
    if (!p || p.session_id !== sessionId) throw new RepositoryNotFoundError(`proposal ${proposalId} not found`);
    if (p.status === "staged") db.prepare("UPDATE trial_proposals SET status='expired' WHERE id=?").run(proposalId);
    const g = db.prepare("SELECT execution_id, status FROM trial_grants WHERE proposal_id=?").get(proposalId) as { execution_id: string; status: string } | undefined;
    if (g && g.status === "queued") db.prepare("UPDATE trial_grants SET status='revoked' WHERE execution_id=?").run(g.execution_id);
    void now;
  });
}
