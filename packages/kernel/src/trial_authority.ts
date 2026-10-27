// Schema12 AUTONOMY TRIAL AUTHORITY domain (leaf module: no autonomy.ts
// import, to avoid an autonomy->trials->autonomy cycle; shared
// transaction/idempotency helpers come from canonical.js. Direct SQL reads).
// Owner/session check BEFORE cache; cached-somebody replay BEFORE mutable
// authority/profile/state checks; body drift 409; foreign 404.

import { createHash } from "node:crypto";
import {
  ConstraintRuleSchema,
  type TrialLaunchRequest,
  TrialLaunchRequestSchema,
  type TrialOperation,
  type TrialProfileSnapshot,
  TrialProfileSnapshotSchema,
  type TrialProposalView,
  TrialProposalViewSchema,
  type TrialWireMode,
  type TrustedRuntimeObservation,
  TrustedRuntimeObservationSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { parseStrictInstantMs } from "./action_strategy.js";
import {
  canonicalJsonString,
  generateId,
  IDEMPOTENCY_OPERATIONS,
  readIdempotencyRow,
  requestHash,
  withImmediateTx,
  writeIdempotencyRow,
} from "./canonical.js";
import {
  IdempotencyConflictError,
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

export type { TrialProfileSnapshot, TrustedRuntimeObservation };

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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s,
    )
  )
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  return s;
}
function requireId(id: unknown, what: string): string {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  return id;
}
function withImmediate<T>(db: Database.Database, fn: () => T): T {
  return withImmediateTx(db, fn);
}
function stored(db: Database.Database, scope: string, key: string) {
  const row = readIdempotencyRow(db, scope, key);
  if (!row) return null;
  return {
    requestHash: row.requestHash,
    status: row.responseStatus,
    body: parseOr(
      () => JSON.parse(row.responseBody),
      "stored idempotency body",
    ),
  };
}
function store(
  db: Database.Database,
  scope: string,
  key: string,
  hash: string,
  status: number,
  body: unknown,
  now: number,
) {
  writeIdempotencyRow(db, scope, key, hash, status, JSON.stringify(body), now);
}
function requireSession(db: Database.Database, s: string) {
  const r = db.prepare("SELECT id FROM sessions WHERE id=?").get(s) as
    | { id: string }
    | undefined;
  if (!r) throw new RepositoryNotFoundError(`session ${s} not found`);
}

/* ------------------------------------------------------------------ */
/* Canonical literal paths                                              */
/* ------------------------------------------------------------------ */

/**
 * Canonical valid literal paths: no traversal, no absolute, no backslash,
 * no NUL, no "." / ".." segments (except the whole-repo "." itself), no
 * trailing slash, no globs. "." alone means the whole repo (any-side
 * intersects every prefix/path).
 */
export function assertCanonicalLiteralPath(p: string, what: string): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512)
    throw new RepositoryValidationError(`${what} must be 1..512 chars`);
  if (p === ".") return p;
  if (p.includes("\0"))
    throw new RepositoryValidationError(`${what} must not contain NUL`);
  if (p.includes("\\"))
    throw new RepositoryValidationError(`${what} must not contain backslash`);
  if (p.includes("*") || p.includes("?"))
    throw new RepositoryValidationError(`${what} must be literal (no globs)`);
  if (p.startsWith("/"))
    throw new RepositoryValidationError(`${what} must be relative`);
  if (p.length > 1 && p.endsWith("/"))
    throw new RepositoryValidationError(`${what} must not end with /`);
  const segs = p.split("/");
  for (const s of segs) {
    if (s.length === 0)
      throw new RepositoryValidationError(`${what} has an empty segment`);
    if (s === "." || s === "..")
      throw new RepositoryValidationError(
        `${what} must not contain . or .. segments`,
      );
  }
  return p;
}

function assertWorkspaceAlias(a: string, what: string): string {
  if (typeof a !== "string" || !/^[a-z0-9_-]{1,64}$/.test(a))
    throw new RepositoryValidationError(`${what} must match [a-z0-9_-]{1,64}`);
  return a;
}

/** Strict rule validation: unknown/corrupt fails closed; empty ruleset rejected. */
export function parseConstraintRule(value: unknown): {
  denyWorkspace: string[];
  denyOperation: TrialOperation[];
  denyWritePath: { workspaceAlias: string; literalPrefix: string }[];
} {
  return parseOr(() => {
    if (value === null || value === undefined)
      throw new Error("null rule is unstructured HOLD, not a structured rule");
    const r = ConstraintRuleSchema.parse(value);
    if (
      r.denyWorkspace.length === 0 &&
      r.denyOperation.length === 0 &&
      r.denyWritePath.length === 0
    )
      throw new Error(
        "empty ruleset is a structured no-op: rejected (omit the rule for unstructured HOLD)",
      );
    for (const w of r.denyWorkspace)
      assertWorkspaceAlias(w, "denyWorkspace entry");
    for (const p of r.denyWritePath) {
      assertWorkspaceAlias(p.workspaceAlias, "deny_write_path workspaceAlias");
      assertCanonicalLiteralPath(
        p.literalPrefix,
        "deny_write_path literalPrefix",
      );
    }
    return r;
  }, "constraintRule");
}

/**
 * Literal path scope check: "." on EITHER side intersects everything;
 * otherwise ancestor+descendant (segment-boundary) intersect => blocked.
 */
export function pathIntersectsDenied(
  writePath: string,
  prefix: string,
): boolean {
  if (writePath === "." || prefix === ".") return true;
  const w = assertCanonicalLiteralPath(writePath, "writePath");
  const d = assertCanonicalLiteralPath(prefix, "deny_write_path literalPrefix");
  if (w === d) return true;
  const wSegs = w.split("/");
  const dSegs = d.split("/");
  const min = Math.min(wSegs.length, dSegs.length);
  for (let i = 0; i < min; i++) {
    if (wSegs[i] !== dSegs[i]) return false;
  }
  return true;
}

interface PurposeRow {
  id: string;
  session_id: string;
  scope: string;
  kind: string;
  is_explicit: number;
  source_kind: string;
  status: string;
  version: number;
  valid_from: string | null;
  valid_until: string | null;
}
interface TaskRow {
  id: string;
  session_id: string;
  scope: string;
  kind: string;
  status: string;
  version: number;
  parent_purpose_id: string | null;
}

/**
 * Strict applicability: NULL bounds are unbounded (end exclusive). Present
 * bounds MUST be strict instants; invalid time data fails closed (holding).
 * Returns "hold" (fail closed), true (applicable), or false (future/expired
 * => irrelevant until the boundary).
 */
function constraintApplicability(
  row: PurposeRow,
  now: number,
): "hold" | boolean {
  if (row.valid_from !== null) {
    const ms = parseStrictInstantMs(row.valid_from);
    if (ms === undefined) return "hold";
    if (ms > now) return false;
  }
  if (row.valid_until !== null) {
    const ms = parseStrictInstantMs(row.valid_until);
    if (ms === undefined) return "hold";
    if (now >= ms) return false;
  }
  return true;
}

function applicable(row: PurposeRow, now: number): boolean {
  const a = constraintApplicability(row, now);
  return a === true;
}

/**
 * Authoritative constraints ONLY: kind=constraint, status=active,
 * source_kind=user, is_explicit=1, strictly applicable window. One joined
 * SQL (no N+1); invalid time data fails closed (holding).
 */
function activeConstraints(
  db: Database.Database,
  session: string,
  scope: string,
  now: number,
): { rule: ReturnType<typeof parseConstraintRule>; unstructured: boolean }[] {
  const out: {
    rule: ReturnType<typeof parseConstraintRule>;
    unstructured: boolean;
  }[] = [];
  const rows = db
    .prepare(
      "SELECT p.id AS purpose_id, p.valid_from AS valid_from, p.valid_until AS valid_until, r.rule_json AS rule_json FROM autonomy_purposes p LEFT JOIN trial_constraint_rules r ON r.purpose_id = p.id WHERE p.session_id=? AND p.scope=? AND p.kind='constraint' AND p.status='active' AND p.source_kind='user' AND p.is_explicit=1",
    )
    .all(session, scope) as {
    purpose_id: string;
    valid_from: string | null;
    valid_until: string | null;
    rule_json: string | null;
  }[];
  for (const row of rows) {
    const app = constraintApplicability(
      {
        id: row.purpose_id,
        session_id: session,
        scope,
        kind: "constraint",
        is_explicit: 1,
        source_kind: "user",
        status: "active",
        version: 1,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
      },
      now,
    );
    // Future/expired constraints are irrelevant until the boundary.
    if (app === false) continue;
    // Invalid time data fails closed: HOLD.
    if (app === "hold") {
      out.push({
        rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] },
        unstructured: true,
      });
      continue;
    }
    if (row.rule_json === null) {
      // No structured rule (or explicitly cleared): unstructured HOLD.
      out.push({
        rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] },
        unstructured: true,
      });
    } else {
      try {
        out.push({
          rule: parseConstraintRule(JSON.parse(row.rule_json)),
          unstructured: false,
        });
      } catch {
        // Unknown/corrupt stored rule fails closed.
        out.push({
          rule: { denyWorkspace: [], denyOperation: [], denyWritePath: [] },
          unstructured: true,
        });
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
  db: Database.Database,
  sessionId: string,
  taskId: string,
  operation: TrialOperation,
  writePaths: string[],
  workspaceAlias: string,
  now: number,
): { goalId: string; goalVersion: number; taskVersion: number; scope: string } {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  assertWorkspaceAlias(workspaceAlias, "workspaceAlias");
  const frozenNow = nowMs(now);
  const normPaths = writePaths.map((w) =>
    assertCanonicalLiteralPath(w, "writePath"),
  );
  const t = db.prepare("SELECT * FROM autonomy_tasks WHERE id=?").get(task) as
    | TaskRow
    | undefined;
  if (!t || t.session_id !== session)
    throw new RepositoryNotFoundError(
      `task ${task} not found in session ${session}`,
    );
  if (t.kind !== "task")
    throw new RepositoryValidationError("authority requires kind=task");
  if (
    t.status === "held" ||
    t.status === "completed" ||
    t.status === "cancelled"
  )
    throw new RepositoryValidationError(
      `task ${t.id} is ${t.status}: no authority`,
    );
  if (t.parent_purpose_id === null)
    throw new RepositoryValidationError("task has no parent goal");
  const g = db
    .prepare("SELECT * FROM autonomy_purposes WHERE id=?")
    .get(t.parent_purpose_id) as PurposeRow | undefined;
  if (
    !g ||
    g.session_id !== session ||
    g.kind !== "goal" ||
    g.scope !== t.scope
  )
    throw new RepositoryNotFoundError(
      `parent goal not found in session ${session}`,
    );
  if (g.status !== "active" || !applicable(g, frozenNow))
    throw new RepositoryValidationError(`parent goal is not active/applicable`);
  if (g.source_kind !== "user" || g.is_explicit !== 1)
    throw new RepositoryValidationError(
      "authority requires explicit user goal",
    );
  // self/external claims never authority even explicit=true: task speaker
  // is not consulted here beyond kind; goal provenance is decisive.
  // Owner-recorded conflict involving goal HOLDS even other member external.
  const conflict = db
    .prepare(
      "SELECT 1 FROM autonomy_purpose_conflicts c JOIN autonomy_purposes pa ON pa.id=c.purpose_a_id JOIN autonomy_purposes pb ON pb.id=c.purpose_b_id WHERE c.session_id=? AND (c.purpose_a_id=? OR c.purpose_b_id=?) AND pa.status='active' AND pb.status='active' LIMIT 1",
    )
    .get(session, g.id, g.id);
  if (conflict)
    throw new RepositoryValidationError(
      "goal is in recorded conflict: authority held",
    );
  // Constraints: unstructured HOLDS everything; structured deny checks.
  const rules = activeConstraints(db, session, t.scope, frozenNow);
  for (const c of rules) {
    if (c.unstructured)
      throw new RepositoryValidationError(
        "unstructured authoritative constraint holds",
      );
  }
  for (const c of rules) {
    if (c.rule.denyWorkspace.includes(workspaceAlias))
      throw new RepositoryValidationError(`workspace ${workspaceAlias} denied`);
    if ((c.rule.denyOperation as string[]).includes(operation))
      throw new RepositoryValidationError(`operation ${operation} denied`);
    for (const d of c.rule.denyWritePath) {
      if (d.workspaceAlias !== workspaceAlias) continue;
      for (const w of normPaths) {
        if (pathIntersectsDenied(w, d.literalPrefix))
          throw new RepositoryValidationError(
            `write path ${w} denied under ${d.literalPrefix}`,
          );
      }
    }
  }
  if (
    (operation === "investigate" || operation === "verify") &&
    normPaths.length > 0
  )
    throw new RepositoryValidationError(`${operation} is read-only`);
  return {
    goalId: g.id,
    goalVersion: g.version,
    taskVersion: t.version,
    scope: t.scope,
  };
}

/**
 * Deterministic wire launch-request hash: SHA-256 hex of the wire-canonical
 * JSON (object keys sorted recursively, arrays keep order) over ALL request
 * fields EXCEPT taskHash (including executionId). Mirrors the companion
 * `computeTaskHash` byte-for-byte; never a taskId:version shortcut.
 */
function wireCanonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        throw new RepositoryValidationError(
          "canonical value carries non-finite number",
        );
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      throw new RepositoryValidationError("canonical value carries undefined");
    default:
      break;
  }
  if (Array.isArray(value))
    return `[${value.map((e) => wireCanonicalize(e)).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${wireCanonicalize(rec[k])}`).join(",")}}`;
  }
  throw new RepositoryValidationError(
    "canonical value carries an unsupported type",
  );
}

export function hashTrialRequest(req: TrialLaunchRequest): string {
  const { taskHash: _drop, ...rest } = req as TrialLaunchRequest & {
    taskHash: string;
  };
  if ("operation" in (rest as Record<string, unknown>))
    throw new RepositoryValidationError(
      "wire request must not carry domain operation",
    );
  return createHash("sha256")
    .update(wireCanonicalize(rest), "utf8")
    .digest("hex");
}

/** Wire mode derived at CLAIM from the frozen readOnly flag (never remapped). */
export function wireModeForReadOnly(readOnly: boolean): TrialWireMode {
  return readOnly ? "read_only" : "write";
}

export interface StageInput {
  taskId: string;
  objective: string;
  acceptance: string[];
  literalPatchPaths: string[];
  operation: TrialOperation;
  readOnlyMode: boolean;
  expiry: string;
  possibleExternalDataConsent: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  requiredChecks: string[];
  workspaceAlias: string;
}
export interface ClaimDeps {
  profile: TrialProfileSnapshot;
}

function profileOrThrow(p: TrialProfileSnapshot): TrialProfileSnapshot {
  const parsed = parseOr(
    () => TrialProfileSnapshotSchema.parse(p),
    "profile snapshot",
  );
  const uniq = new Set(parsed.mandatoryChecks);
  if (uniq.size !== parsed.mandatoryChecks.length)
    throw new RepositoryValidationError(
      "profile mandatoryChecks must be unique",
    );
  return parsed;
}

function requireChecksOrThrow(
  requiredChecks: string[],
  mandatory: string[],
): string[] {
  if (requiredChecks.length === 0 || requiredChecks.length > 16)
    throw new RepositoryValidationError(
      "requiredChecks must carry 1..16 entries",
    );
  const uniq = new Set(requiredChecks);
  if (uniq.size !== requiredChecks.length)
    throw new RepositoryValidationError("requiredChecks must be unique");
  for (const id of requiredChecks) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new RepositoryValidationError(
        `required check id must match [A-Za-z0-9_-]{1,64}: ${id}`,
      );
  }
  // The operator profile advertises ONLY the mandatory set: the request must
  // carry that exact set (no unadvertised optional IDs accepted even when the
  // mandatory subset matches), so a `done` result can never be asked to
  // prove an ID the operator never advertised.
  const want = new Set(mandatory);
  if (uniq.size !== want.size || ![...uniq].every((id) => want.has(id)))
    throw new RepositoryValidationError(
      "requiredChecks must equal the operator mandatory check set exactly",
    );
  return [...requiredChecks];
}

function normalizeWireConstraints(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new RepositoryValidationError("constraints must be an array");
  if (value.length > 16)
    throw new RepositoryValidationError("constraints must carry 0..16 entries");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length < 1 ||
      entry.length > 1024 ||
      entry.includes("\0")
    )
      throw new RepositoryValidationError(
        "constraints entries must be 1..1024 char strings without NUL",
      );
    if (seen.has(entry))
      throw new RepositoryValidationError("constraints must be unique");
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function profileBindingKey(p: TrialProfileSnapshot): string {
  return canonicalJsonString({
    available: p.available,
    enabled: p.enabled,
    mandatoryChecks: [...p.mandatoryChecks].sort(),
    configFingerprint: p.configFingerprint,
    sourceRevision: p.sourceRevision,
    currentModel: p.currentModel,
    disclosedWholeRepoRead: p.disclosedWholeRepoRead,
    timeoutMs: p.timeoutMs,
    maxOutputBytes: p.maxOutputBytes,
  });
}

function requireProfileForNewGrant(profile: TrialProfileSnapshot): void {
  if (!profile.available || !profile.enabled)
    throw new RepositoryValidationError(
      "profile unavailable/disabled: no new grant",
    );
  if (!profile.disclosedWholeRepoRead)
    throw new RepositoryValidationError(
      "approved scope requires whole-repo READ disclosure",
    );
  // Operator caps must admit at least the smallest valid wire request.
  if (profile.timeoutMs < 1000 || profile.maxOutputBytes < 1024)
    throw new RepositoryValidationError(
      "profile caps below wire minimum: feature unavailable",
    );
}

/** Stage DATA-only proposal (authority checked, frozen versions + profile). */
export function stageTrialProposal(
  db: Database.Database,
  sessionId: string,
  input: StageInput,
  options: { key: string; now?: number; profile: TrialProfileSnapshot },
): { status: number; body: TrialProposalView; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  const scope = `session:${session}:trial-stage`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.stageTrial.operation,
    IDEMPOTENCY_OPERATIONS.stageTrial.schemaVersion,
    {
      sessionId: session,
      ...input,
      profile: JSON.parse(profileBindingKey(profile)),
    },
  );
  return withImmediate(db, () => {
    requireSession(db, session);
    const ex = stored(db, scope, key);
    if (ex) {
      if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
      // Replayed old cached DTO returned unchanged: never rewritten.
      return {
        status: ex.status,
        body: parseOr(
          () => TrialProposalViewSchema.parse(ex.body),
          "stored proposal",
        ),
        replayed: true,
      };
    }
    if (parseStrictInstantMs(input.expiry) === undefined)
      throw new RepositoryValidationError(
        "expiry must be strict RFC3339 instant",
      );
    if ((parseStrictInstantMs(input.expiry) as number) <= now)
      throw new RepositoryValidationError("proposal already expired");
    requireProfileForNewGrant(profile);
    assertWorkspaceAlias(input.workspaceAlias, "workspaceAlias");
    requireNoActiveFence(db, input.workspaceAlias, "stage");
    // Wire-subset bounds fail closed BEFORE human approval/authority consume.
    if (input.objective.length < 1 || input.objective.length > 8192)
      throw new RepositoryValidationError("objective must be 1..8192 chars");
    if (input.acceptance.length < 1 || input.acceptance.length > 16)
      throw new RepositoryValidationError(
        "acceptance must carry 1..16 entries",
      );
    for (const a of input.acceptance) {
      if (a.length < 1 || a.length > 1024)
        throw new RepositoryValidationError(
          "acceptance entries must be 1..1024 chars",
        );
    }
    if (
      input.literalPatchPaths.length < 1 ||
      input.literalPatchPaths.length > 16
    )
      throw new RepositoryValidationError(
        "literalPatchPaths must carry 1..16 entries",
      );
    if (input.timeoutMs < 1000 || input.timeoutMs > 3600000)
      throw new RepositoryValidationError(
        "timeoutMs must be in [1000, 3600000]",
      );
    if (input.maxOutputBytes < 1024 || input.maxOutputBytes > 268435456)
      throw new RepositoryValidationError(
        "maxOutputBytes must be in [1024, 268435456]",
      );
    const normPaths = input.literalPatchPaths.map((w) =>
      assertCanonicalLiteralPath(w, "literalPatchPath"),
    );
    // Overlapping literal scopes are ambiguous: reject before grant.
    for (let i = 0; i < normPaths.length; i++) {
      for (let j = 0; j < normPaths.length; j++) {
        if (i === j) continue;
        const a = normPaths[i] as string,
          b = normPaths[j] as string;
        if (a === "." || b === ".") {
          if (normPaths.length > 1)
            throw new RepositoryValidationError(
              "'.' overlaps every scope: carry it alone",
            );
          continue;
        }
        if (b === a || b.startsWith(`${a}/`))
          throw new RepositoryValidationError(
            `literalPatchPaths carries overlapping scopes: ${a} vs ${b}`,
          );
      }
    }
    const auth = checkTrialAuthority(
      db,
      session,
      input.taskId,
      input.operation,
      input.readOnlyMode ? [] : normPaths,
      input.workspaceAlias,
      now,
    );
    if (
      input.readOnlyMode !==
      (input.operation === "investigate" || input.operation === "verify")
    ) {
      // readOnlyMode must match closed read-only ops explicitly.
      throw new RepositoryValidationError(
        "readOnlyMode must match read-only operation",
      );
    }
    if (input.timeoutMs > profile.timeoutMs)
      throw new RepositoryValidationError(
        "request timeoutMs exceeds operator cap",
      );
    if (input.maxOutputBytes > profile.maxOutputBytes)
      throw new RepositoryValidationError(
        "request maxOutputBytes exceeds operator cap",
      );
    const checks = requireChecksOrThrow(
      input.requiredChecks,
      profile.mandatoryChecks,
    );
    const id = generateId();
    db.prepare(
      "INSERT INTO trial_proposals (id, session_id, scope, task_id, goal_id, goal_version, task_version, objective, acceptance_json, paths_json, operation, read_only, expiry, consent, timeout_ms, max_output_bytes, checks_json, status, created_at, workspace_alias, profile_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, ?)",
    ).run(
      id,
      session,
      auth.scope,
      input.taskId,
      auth.goalId,
      auth.goalVersion,
      auth.taskVersion,
      input.objective,
      JSON.stringify(input.acceptance),
      JSON.stringify(normPaths),
      input.operation,
      input.readOnlyMode ? 1 : 0,
      input.expiry,
      input.possibleExternalDataConsent ? 1 : 0,
      input.timeoutMs,
      input.maxOutputBytes,
      JSON.stringify(checks),
      "staged",
      now,
      input.workspaceAlias,
      JSON.stringify(profile),
    );
    const body = parseOr(
      () =>
        TrialProposalViewSchema.parse({
          id,
          sessionId: session,
          scope: auth.scope,
          taskId: input.taskId,
          goalId: auth.goalId,
          goalVersion: auth.goalVersion,
          taskVersion: auth.taskVersion,
          objective: input.objective,
          acceptance: input.acceptance,
          constraints: [],
          literalPatchPaths: normPaths,
          operation: input.operation,
          readOnlyMode: input.readOnlyMode,
          expiry: input.expiry,
          possibleExternalDataConsent: input.possibleExternalDataConsent,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          requiredChecks: checks,
          status: "staged",
          createdAt: now,
          workspaceAlias: input.workspaceAlias,
          profile: {
            configFingerprint: profile.configFingerprint,
            sourceRevision: profile.sourceRevision,
          },
        }),
      "proposal view",
    );
    store(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export function listTrialProposals(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): { items: TrialProposalView[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT * FROM trial_proposals WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
    )
    .all(session, capped) as Parameters<typeof toProposalView>[0][];
  return { items: rows.map((r) => toProposalView(r)) };
}
/**
 * Pure single-proposal read (never expires/mutates). Foreign or missing
 * rows are 404: the detail route must read by id directly instead of
 * paging the list (the default list limit would 404 tail items).
 */
export function readTrialProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): TrialProposalView {
  const session = requireId(sessionId, "sessionId");
  const pid = requireId(proposalId, "proposalId");
  const row = db.prepare("SELECT * FROM trial_proposals WHERE id=?").get(pid) as
    | Parameters<typeof toProposalView>[0]
    | undefined;
  if (!row || (row as { session_id: string }).session_id !== session)
    throw new RepositoryNotFoundError(
      `proposal ${pid} not found in session ${session}`,
    );
  return toProposalView(row);
}
function toProposalView(r: {
  id: string;
  session_id: string;
  scope: string;
  task_id: string;
  goal_id: string | null;
  goal_version: number | null;
  task_version: number;
  objective: string;
  acceptance_json: string;
  constraints_json?: string | null;
  paths_json: string;
  operation: string;
  read_only: number;
  expiry: string;
  consent: number;
  timeout_ms: number;
  max_output_bytes: number;
  checks_json: string;
  status: string;
  created_at: number;
  workspace_alias?: string | null;
  profile_json?: string | null;
}): TrialProposalView {
  // Legacy rows predate the frozen columns: NULL stays null (unbound), never invented.
  let alias: string | null = null;
  const rawAlias = (r as { workspace_alias?: unknown }).workspace_alias;
  if (typeof rawAlias === "string" && /^[a-z0-9_-]{1,64}$/.test(rawAlias))
    alias = rawAlias;
  let profile: { configFingerprint: string; sourceRevision: string } | null =
    null;
  const rawProfile = (r as { profile_json?: unknown }).profile_json;
  if (typeof rawProfile === "string") {
    try {
      const parsed = JSON.parse(rawProfile) as {
        configFingerprint?: unknown;
        sourceRevision?: unknown;
      };
      if (
        typeof parsed.configFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(parsed.configFingerprint) &&
        typeof parsed.sourceRevision === "string" &&
        /^[0-9a-f]{40}$/.test(parsed.sourceRevision)
      ) {
        profile = {
          configFingerprint: parsed.configFingerprint,
          sourceRevision: parsed.sourceRevision,
        };
      }
    } catch {
      profile = null;
    }
  }
  return parseOr(
    () =>
      TrialProposalViewSchema.parse({
        id: r.id,
        sessionId: r.session_id,
        scope: r.scope,
        taskId: r.task_id,
        goalId: r.goal_id,
        goalVersion: r.goal_version,
        taskVersion: r.task_version,
        objective: r.objective,
        acceptance: JSON.parse(r.acceptance_json),
        constraints:
          typeof r.constraints_json === "string"
            ? (JSON.parse(r.constraints_json) as string[])
            : [],
        literalPatchPaths: JSON.parse(r.paths_json),
        operation: r.operation,
        readOnlyMode: r.read_only === 1,
        expiry: r.expiry,
        possibleExternalDataConsent: r.consent === 1,
        timeoutMs: r.timeout_ms,
        maxOutputBytes: r.max_output_bytes,
        requiredChecks: JSON.parse(r.checks_json),
        status: r.status,
        createdAt: r.created_at,
        workspaceAlias: alias,
        profile,
      }),
    "proposal row",
  );
}

function readStagedProfile(
  db: Database.Database,
  proposalId: string,
): TrialProfileSnapshot {
  const row = db
    .prepare("SELECT profile_json FROM trial_proposals WHERE id=?")
    .get(proposalId) as { profile_json: string | null } | undefined;
  if (!row || row.profile_json === null)
    throw new RepositoryValidationError(
      "proposal has no frozen profile: re-stage",
    );
  return profileOrThrow(
    parseOr(() => JSON.parse(row.profile_json as string), "frozen profile"),
  );
}

function readProposalAlias(db: Database.Database, proposalId: string): string {
  const row = db
    .prepare("SELECT workspace_alias FROM trial_proposals WHERE id=?")
    .get(proposalId) as { workspace_alias: string | null } | undefined;
  if (!row || row.workspace_alias === null)
    throw new RepositoryValidationError(
      "proposal has no frozen alias: re-stage",
    );
  return row.workspace_alias;
}

export interface PolicyGrantInput {
  taskId: string;
  objective: string;
  acceptance: string[];
  /** Already-prefixed plan decisions/non-goals/steps. Omitted = none.
   * Bounded exactly like the wire `constraints` field; over-bound input
   * fails before any proposal/grant write. */
  constraints?: string[];
  literalPatchPaths: string[];
  operation: TrialOperation;
  readOnlyMode: boolean;
  expiry: string;
  possibleExternalDataConsent: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  requiredChecks: string[];
  workspaceAlias: string;
}

/**
 * Host policy-authorized grant derivation. This is the narrow extension of
 * the SAME TrialAuthority owner used by human approval: it never invokes the
 * human approve endpoint or bypasses CAS/one-use/fencing/claim/launch-permit/
 * result/quiescence. It writes a complete frozen proposal + one queued grant
 * in one immediate transaction after re-running every authority check.
 *
 * Only trusted host code may call this. A model/HTTP request body cannot name
 * this path, a different profile/alias, a check set, or a numeric cap.
 */
export function derivePolicyTrialGrant(
  db: Database.Database,
  sessionId: string,
  input: PolicyGrantInput,
  options: {
    now?: number;
    profile: TrialProfileSnapshot;
    workspaceAlias: string;
    /** Trusted host preallocated UUID; never a model/HTTP body field. */
    executionId?: string;
  },
): { proposalId: string; executionId: string; status: "queued" } {
  const session = requireId(sessionId, "sessionId");
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  assertWorkspaceAlias(options.workspaceAlias, "workspaceAlias");
  return withImmediate(db, () => {
    requireSession(db, session);
    if (input.workspaceAlias !== options.workspaceAlias)
      throw new RepositoryValidationError(
        "policy grant alias must match the operator alias",
      );
    const expiryMs = parseStrictInstantMs(input.expiry);
    if (expiryMs === undefined || expiryMs <= now)
      throw new RepositoryValidationError(
        "policy grant expiry must be a future strict instant",
      );
    requireProfileForNewGrant(profile);
    requireNoActiveFence(db, input.workspaceAlias, "derive");
    if (input.objective.length < 1 || input.objective.length > 8192)
      throw new RepositoryValidationError("objective must be 1..8192 chars");
    if (input.acceptance.length < 1 || input.acceptance.length > 16)
      throw new RepositoryValidationError(
        "acceptance must carry 1..16 entries",
      );
    for (const a of input.acceptance) {
      if (a.length < 1 || a.length > 1024)
        throw new RepositoryValidationError(
          "acceptance entries must be 1..1024 chars",
        );
    }
    if (
      input.literalPatchPaths.length < 1 ||
      input.literalPatchPaths.length > 16
    )
      throw new RepositoryValidationError(
        "literalPatchPaths must carry 1..16 entries",
      );
    if (input.timeoutMs < 1000 || input.timeoutMs > profile.timeoutMs)
      throw new RepositoryValidationError(
        "timeoutMs exceeds the frozen operator profile",
      );
    if (
      input.maxOutputBytes < 1024 ||
      input.maxOutputBytes > profile.maxOutputBytes
    )
      throw new RepositoryValidationError(
        "maxOutputBytes exceeds the frozen operator profile",
      );
    const normPaths = input.literalPatchPaths.map((w) =>
      assertCanonicalLiteralPath(w, "literalPatchPath"),
    );
    if (
      input.readOnlyMode !==
      (input.operation === "investigate" || input.operation === "verify")
    )
      throw new RepositoryValidationError(
        "readOnlyMode must match read-only operation",
      );
    const checks = requireChecksOrThrow(
      input.requiredChecks,
      profile.mandatoryChecks,
    );
    const constraints = normalizeWireConstraints(input.constraints);
    const ctl = db
      .prepare("SELECT paused, version FROM autonomy_control WHERE id='global'")
      .get() as { paused: number; version: number } | undefined;
    if (ctl === undefined || ctl.paused === 1)
      throw new RepositoryValidationError("autonomy paused: no policy grant");
    const auth = checkTrialAuthority(
      db,
      session,
      input.taskId,
      input.operation,
      input.readOnlyMode ? [] : normPaths,
      input.workspaceAlias,
      now,
    );
    const proposalId = generateId();
    db.prepare(
      "INSERT INTO trial_proposals (id, session_id, scope, task_id, goal_id, goal_version, task_version, objective, acceptance_json, paths_json, operation, read_only, expiry, consent, timeout_ms, max_output_bytes, checks_json, constraints_json, status, created_at, workspace_alias, profile_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'granted', ?, ?, ?)",
    ).run(
      proposalId,
      session,
      auth.scope,
      input.taskId,
      auth.goalId,
      auth.goalVersion,
      auth.taskVersion,
      input.objective,
      JSON.stringify(input.acceptance),
      JSON.stringify(normPaths),
      input.operation,
      input.readOnlyMode ? 1 : 0,
      input.expiry,
      input.possibleExternalDataConsent ? 1 : 0,
      input.timeoutMs,
      input.maxOutputBytes,
      JSON.stringify(checks),
      JSON.stringify(constraints),
      now,
      input.workspaceAlias,
      JSON.stringify(profile),
    );
    const executionId =
      options.executionId === undefined
        ? generateId()
        : requireId(options.executionId, "executionId");
    db.prepare(
      "INSERT INTO trial_grants (execution_id, proposal_id, session_id, scope, status, cancel_requested, control_generation, created_at, workspace_alias, approved_profile_json) VALUES (?,?,?,?, 'queued', 0, ?, ?, ?, ?)",
    ).run(
      executionId,
      proposalId,
      session,
      auth.scope,
      ctl.version,
      now,
      input.workspaceAlias,
      JSON.stringify(profile),
    );
    return { proposalId, executionId, status: "queued" as const };
  });
}

/**
 * Shared freshness for POLICY-DERIVED grants only. A grant with no
 * autodispatch execution link is a manual human grant and is unaffected.
 * The host policy/plan/control generation and the frozen human source
 * turn/run are re-read from the SAME owner DB at claim, permit, and result,
 * so a revoked/expired policy, a superseded plan revision, a newer user
 * turn/retry selection, a version change, or a STOP+resume generation change
 * can never be authorized after the fact. Manual grants stay unaffected.
 */
function policyGrantFreshness(
  db: Database.Database,
  sessionId: string,
  executionId: string,
  grantControlGeneration: number,
  now: number,
): string | null {
  const row = db
    .prepare(
      "SELECT e.status AS execution_status, e.policy_version AS execution_policy_version, p.status AS policy_status, p.version AS policy_version, p.expires_at AS expires_at, pl.id AS plan_id, pl.status AS plan_status, pl.policy_version AS plan_policy_version, pl.source_turn_id AS source_turn_id, pl.source_run_id AS source_run_id FROM autodispatch_executions e JOIN autodispatch_policies p ON p.id=e.policy_id AND p.session_id=e.session_id JOIN autodispatch_plans pl ON pl.id=e.plan_id AND pl.session_id=e.session_id WHERE e.execution_id=? AND e.session_id=?",
    )
    .get(executionId, sessionId) as
    | {
        execution_status: string;
        execution_policy_version: number;
        policy_status: string;
        policy_version: number;
        expires_at: string | null;
        plan_id: string;
        plan_status: string;
        plan_policy_version: number;
        source_turn_id: string;
        source_run_id: string;
      }
    | undefined;
  if (row === undefined) return null; // manual grant
  if (row.execution_status !== "authorized") return "policy-not-authorized";
  if (row.policy_status !== "active") return `policy-${row.policy_status}`;
  if (row.expires_at !== null) {
    const expiry = parseStrictInstantMs(row.expires_at);
    if (expiry === undefined || expiry <= now) return "policy-expired";
  }
  if (
    row.policy_version !== row.execution_policy_version ||
    row.plan_policy_version !== row.policy_version
  )
    return "policy-version-drift";
  if (row.plan_status !== "dispatched") return "plan-superseded";
  const latest = db
    .prepare(
      "SELECT id FROM autodispatch_plans WHERE session_id=? AND status NOT IN ('superseded') ORDER BY revision DESC LIMIT 1",
    )
    .get(sessionId) as { id: string } | undefined;
  if (latest === undefined || latest.id !== row.plan_id) return "plan-stale";
  // The plan freezes the accepted human source turn/run. Compare it to the
  // CURRENT latest human user_text turn (any run status) and that turn's
  // CURRENT selected completed run. A fresh queued/completed/cancelled turn
  // or a retry-selection change invalidates the old grant even when the
  // planner never persisted a newer plan.
  const currentTurn = db
    .prepare(
      "SELECT id FROM turns WHERE session_id=? AND json_extract(input_json,'$.kind')='user_text' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId) as { id: string } | undefined;
  if (currentTurn === undefined || currentTurn.id !== row.source_turn_id)
    return "source-stale";
  const currentRun = db
    .prepare(
      "SELECT s.run_id AS run_id FROM turn_selections s JOIN runs r ON r.id=s.run_id WHERE s.turn_id=? AND r.status='completed'",
    )
    .get(currentTurn.id) as { run_id: string } | undefined;
  if (currentRun === undefined || currentRun.run_id !== row.source_run_id)
    return "source-stale";
  const ctl = db
    .prepare("SELECT version FROM autonomy_control WHERE id='global'")
    .get() as { version: number } | undefined;
  if (ctl === undefined || ctl.version !== grantControlGeneration)
    return "control-generation";
  return null;
}

/**
 * Internal proof read for the execution-profile/recovery boundary: true ONLY
 * for an owned grant that is revoked before ever being claimed or launched.
 * A missing/foreign grant is false; database errors propagate. This is a
 * pure SELECT (one statement, no transaction/mutation).
 */
export function isNeverLaunchedRevokedTrialGrant(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM trial_grants g WHERE g.execution_id=? AND g.session_id=? AND g.status='revoked' AND g.claimed_at IS NULL AND g.request_json IS NULL AND NOT EXISTS (SELECT 1 FROM trial_worker_boots b WHERE b.execution_id=g.execution_id) AND NOT EXISTS (SELECT 1 FROM trial_launch_permits p WHERE p.execution_id=g.execution_id) AND NOT EXISTS (SELECT 1 FROM trial_worker_outcomes o WHERE o.execution_id=g.execution_id) LIMIT 1",
    )
    .get(executionId, sessionId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Approve: fresh goal/task/constraints/profile/expiry/unpaused checks; one grant. */
export function approveTrialProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  options: {
    key: string;
    now?: number;
    profile: TrialProfileSnapshot;
    workspaceAlias: string;
    /** Trusted host preallocated UUID; never a model/HTTP body field. */
    executionId?: string;
  },
): {
  status: number;
  body: {
    executionId: string;
    proposalId: string;
    sessionId: string;
    scope: string;
    status: string;
    cancelRequested: boolean;
    controlGeneration: number;
    createdAt: number;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const pid = requireId(proposalId, "proposalId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  assertWorkspaceAlias(options.workspaceAlias, "workspaceAlias");
  const scope = `trial-proposal:${pid}`;
  const out = withImmediate(
    db,
    (): {
      status: number;
      body: {
        executionId: string;
        proposalId: string;
        sessionId: string;
        scope: string;
        status: string;
        cancelRequested: boolean;
        controlGeneration: number;
        createdAt: number;
      };
      replayed: boolean;
    } | null => {
      const prow = db
        .prepare("SELECT * FROM trial_proposals WHERE id=?")
        .get(pid) as Parameters<typeof toProposalView>[0] | undefined;
      if (!prow || (prow as { session_id: string }).session_id !== session)
        throw new RepositoryNotFoundError(
          `proposal ${pid} not found in session ${session}`,
        );
      const hash = requestHash(
        IDEMPOTENCY_OPERATIONS.approveTrial.operation,
        IDEMPOTENCY_OPERATIONS.approveTrial.schemaVersion,
        {
          sessionId: session,
          proposalId: pid,
          workspaceAlias: options.workspaceAlias,
          profile: JSON.parse(profileBindingKey(profile)),
        },
      );
      const ex = stored(db, scope, key);
      if (ex) {
        if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
        return {
          status: ex.status,
          body: ex.body as {
            executionId: string;
            proposalId: string;
            sessionId: string;
            scope: string;
            status: string;
            cancelRequested: boolean;
            controlGeneration: number;
            createdAt: number;
          },
          replayed: true,
        };
      }
      // UNIQUE(proposal_id) prevents different-keys double approve.
      const prior = db
        .prepare("SELECT execution_id FROM trial_grants WHERE proposal_id=?")
        .get(pid) as { execution_id: string } | undefined;
      if (prior)
        throw new RepositoryValidationError(
          "proposal already granted (one grant per approval)",
        );
      const view = toProposalView(prow);
      if (view.status !== "staged")
        throw new RepositoryValidationError(`proposal is ${view.status}`);
      if ((parseStrictInstantMs(view.expiry) ?? NaN) <= now) {
        // Commit the expiry, then report it OUTSIDE the transaction: throwing
        // here would roll the expiry write back (fail-open on retry).
        db.prepare(
          "UPDATE trial_proposals SET status='expired' WHERE id=?",
        ).run(pid);
        return null;
      }
      requireProfileForNewGrant(profile);
      requireNoActiveFence(db, options.workspaceAlias, "approve");
      // Human-approved profile MUST match the profile SHOWN/staged: drift => 409.
      const staged = readStagedProfile(db, pid);
      if (profileBindingKey(profile) !== profileBindingKey(staged))
        throw new RepositoryValidationError(
          "profile drift since staging: re-stage for human review",
        );
      const frozenAlias = readProposalAlias(db, pid);
      if (options.workspaceAlias !== frozenAlias)
        throw new RepositoryValidationError(
          "workspace alias drift since staging: re-stage for human review",
        );
      for (const m of profile.mandatoryChecks) {
        if (!view.requiredChecks.includes(m))
          throw new RepositoryValidationError(
            `request drops mandatory check ${m}`,
          );
      }
      // Exact operator set: reject unadvertised optional IDs even when the
      // mandatory subset matches (done must prove exactly the advertised set).
      requireChecksOrThrow(view.requiredChecks, profile.mandatoryChecks);
      const ctl = db
        .prepare(
          "SELECT paused, version FROM autonomy_control WHERE id='global'",
        )
        .get() as { paused: number; version: number };
      if (ctl.paused === 1)
        throw new RepositoryValidationError("autonomy paused: no new grant");
      // Fresh authority re-check before grant (frozen alias, frozen versions
      // must still be current: goal/task version drift => authority fails).
      const auth = checkTrialAuthority(
        db,
        session,
        view.taskId,
        view.operation,
        view.readOnlyMode ? [] : view.literalPatchPaths,
        frozenAlias,
        now,
      );
      if (
        auth.goalVersion !== view.goalVersion ||
        auth.taskVersion !== view.taskVersion
      )
        throw new RepositoryValidationError(
          "goal/task version drift since staging: re-stage for human review",
        );
      const executionId =
        options.executionId === undefined
          ? generateId()
          : requireId(options.executionId, "executionId");
      db.prepare(
        "INSERT INTO trial_grants (execution_id, proposal_id, session_id, scope, status, cancel_requested, control_generation, created_at, workspace_alias, approved_profile_json) VALUES (?,?,?,?, 'queued', 0, ?, ?, ?, ?)",
      ).run(
        executionId,
        pid,
        session,
        view.scope,
        ctl.version,
        now,
        frozenAlias,
        JSON.stringify(profile),
      );
      db.prepare("UPDATE trial_proposals SET status='granted' WHERE id=?").run(
        pid,
      );
      const body = {
        executionId,
        proposalId: pid,
        sessionId: session,
        scope: view.scope,
        status: "queued",
        cancelRequested: false,
        controlGeneration: ctl.version,
        createdAt: now,
      };
      store(db, scope, key, hash, 201, body, now);
      return { status: 201, body, replayed: false };
    },
  );
  if (out === null) throw new RepositoryValidationError("proposal expired");
  return out;
}

/** Exact immutable intent read (pure GET: never mutates). */
export function readTrialIntent(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): {
  grant: {
    executionId: string;
    proposalId: string;
    sessionId: string;
    scope: string;
    status: string;
    cancelRequested: boolean;
    controlGeneration: number;
    createdAt: number;
  };
  proposal: TrialProposalView;
  request: TrialLaunchRequest | null;
} {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const g = db
    .prepare("SELECT * FROM trial_grants WHERE execution_id=?")
    .get(exec) as
    | {
        execution_id: string;
        proposal_id: string;
        session_id: string;
        scope: string;
        status: string;
        cancel_requested: number;
        control_generation: number;
        created_at: number;
        request_json: string | null;
      }
    | undefined;
  if (!g || g.session_id !== session)
    throw new RepositoryNotFoundError(
      `grant ${exec} not found in session ${session}`,
    );
  const prow = db
    .prepare("SELECT * FROM trial_proposals WHERE id=?")
    .get(g.proposal_id) as Parameters<typeof toProposalView>[0];
  if (!prow)
    throw new RepositoryNotFoundError(`proposal ${g.proposal_id} not found`);
  return {
    grant: toGrantView(g),
    proposal: toProposalView(prow),
    request:
      g.request_json === null
        ? null
        : parseOr(
            () =>
              TrialLaunchRequestSchema.parse(
                JSON.parse(g.request_json as string),
              ),
            "frozen request",
          ),
  };
}

/** Claim consumes grant + persists immutable frozen intent BEFORE provider.
 * The wire purpose statement is derived deterministically from the DB: the
 * bound goal's original user statement at the staged goalId/goalVersion. No
 * caller-supplied text is accepted (it would bypass the claim idempotency
 * hash, which covers session/execution/alias/profile only). */
export function claimTrialGrant(
  db: Database.Database,
  sessionId: string,
  executionId: string,
  options: {
    key: string;
    now?: number;
    profile: TrialProfileSnapshot;
    workspaceAlias: string;
  },
): {
  status: number;
  body: {
    kind: "replay" | "result";
    grant: unknown;
    request: TrialLaunchRequest;
    applied: boolean;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const profile = profileOrThrow(options.profile);
  assertWorkspaceAlias(options.workspaceAlias, "workspaceAlias");
  const scope = `trial-claim:${exec}`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.claimTrial.operation,
    IDEMPOTENCY_OPERATIONS.claimTrial.schemaVersion,
    {
      sessionId: session,
      executionId: exec,
      workspaceAlias: options.workspaceAlias,
      profile: JSON.parse(profileBindingKey(profile)),
    },
  );
  return withImmediate(db, () => {
    // Owner/foreign check BEFORE any cache read (foreign => 404, never 409).
    const g = db
      .prepare("SELECT * FROM trial_grants WHERE execution_id=?")
      .get(exec) as
      | {
          execution_id: string;
          proposal_id: string;
          session_id: string;
          scope: string;
          status: string;
          cancel_requested: number;
          control_generation: number;
          created_at: number;
          request_json: string | null;
          workspace_alias: string | null;
          approved_profile_json: string | null;
        }
      | undefined;
    if (!g || g.session_id !== session)
      throw new RepositoryNotFoundError(
        `grant ${exec} not found in session ${session}`,
      );
    // Cached same-key success replays BEFORE current profile/control/authority.
    const ex = stored(db, scope, key);
    if (ex) {
      if (ex.requestHash !== hash) throw new IdempotencyConflictError(scope);
      return {
        status: ex.status,
        body: ex.body as {
          kind: "replay" | "result";
          grant: unknown;
          request: TrialLaunchRequest;
          applied: boolean;
        },
        replayed: true,
      };
    }
    // Claim replay: already-claimed grant returns discriminated replay, no new launch.
    if (g.request_json !== null) {
      const req = parseOr(
        () =>
          TrialLaunchRequestSchema.parse(JSON.parse(g.request_json as string)),
        "frozen request",
      );
      const body = {
        kind: "replay" as const,
        grant: toGrantView(g),
        request: req,
        applied: false,
      };
      store(db, scope, key, hash, 200, body, now);
      return { status: 200, body, replayed: false };
    }
    if (
      g.status === "revoked" ||
      g.status === "consumed" ||
      g.status === "interrupted"
    )
      throw new RepositoryValidationError(`grant is ${g.status}: never resend`);
    if (g.cancel_requested === 1)
      throw new RepositoryValidationError("grant cancel requested");
    const prow = db
      .prepare("SELECT * FROM trial_proposals WHERE id=?")
      .get(g.proposal_id) as Parameters<typeof toProposalView>[0];
    const view = toProposalView(prow);
    if ((parseStrictInstantMs(view.expiry) ?? NaN) <= now)
      throw new RepositoryValidationError("grant expired");
    // Bind control generation AT CLAIM; queued grants survive pause/restart
    // but can claim ONLY after fresh EXPLICIT global resume.
    const ctl = db
      .prepare("SELECT paused, version FROM autonomy_control WHERE id='global'")
      .get() as { paused: number; version: number };
    if (ctl.paused === 1)
      throw new RepositoryValidationError(
        "paused: fresh explicit resume required",
      );
    {
      const stale = policyGrantFreshness(
        db,
        session,
        exec,
        g.control_generation,
        now,
      );
      if (stale !== null)
        throw new RepositoryValidationError(`policy grant stale: ${stale}`);
    }
    if (!profile.available || !profile.enabled)
      throw new RepositoryValidationError("profile unavailable at claim");
    // Frozen alias/profile from APPROVAL bind the claim: never replaced
    // with the current caller alias/profile. Drift => 409 re-stage.
    const frozenAlias =
      g.workspace_alias ?? readProposalAlias(db, g.proposal_id);
    if (options.workspaceAlias !== frozenAlias)
      throw new RepositoryValidationError(
        "workspace alias drift since approval: re-stage for human review",
      );
    const approved =
      g.approved_profile_json === null
        ? readStagedProfile(db, g.proposal_id)
        : profileOrThrow(
            parseOr(
              () => JSON.parse(g.approved_profile_json as string),
              "approved profile",
            ),
          );
    if (profileBindingKey(profile) !== profileBindingKey(approved))
      throw new RepositoryValidationError(
        "profile drift since approval: re-stage for human review",
      );
    if (!approved.disclosedWholeRepoRead)
      throw new RepositoryValidationError(
        "approved scope requires whole-repo READ disclosure",
      );
    const auth = checkTrialAuthority(
      db,
      session,
      view.taskId,
      view.operation,
      view.readOnlyMode ? [] : view.literalPatchPaths,
      frozenAlias,
      now,
    );
    if (
      auth.goalVersion !== view.goalVersion ||
      auth.taskVersion !== view.taskVersion
    )
      throw new RepositoryValidationError(
        "goal/task version drift since approval: re-stage for human review",
      );
    // Caps/checks cannot expand past the approved immutable profile.
    if (
      view.timeoutMs > approved.timeoutMs ||
      view.maxOutputBytes > approved.maxOutputBytes
    )
      throw new RepositoryValidationError(
        "request caps exceed approved operator caps",
      );
    requireChecksOrThrow(view.requiredChecks, approved.mandatoryChecks);
    requireNoActiveFence(db, frozenAlias, "claim");
    // Full frozen runtime must FIT the known authority window (relative
    // timeout only; no partial-runtime optimization, no new wire field).
    requireFitsWindow(
      db,
      session,
      view.taskId,
      view.operation,
      view.readOnlyMode ? [] : view.literalPatchPaths,
      frozenAlias,
      view.expiry,
      view.timeoutMs,
      now,
      "claim",
    );
    // Wire purpose statement comes from the DB goal row actually bound by
    // the authority check above (original user statement at the staged
    // goalId/goalVersion). Over-wire (>4096 chars) or missing goal fails
    // closed BEFORE any write.
    const goalRow = db
      .prepare("SELECT statement FROM autonomy_purposes WHERE id=?")
      .get(auth.goalId) as { statement: string } | undefined;
    if (
      !goalRow ||
      typeof goalRow.statement !== "string" ||
      goalRow.statement.length === 0 ||
      goalRow.statement.length > 4096
    )
      throw new RepositoryValidationError(
        "bound goal statement missing or over wire limit: cannot claim",
      );
    // ACTUAL immutable wire built at CLAIM from frozen values: wire-exact
    // subset only (NO domain `operation` key on the wire; operation stays on
    // the proposal/grant for constraint checks). taskHash is the canonical
    // wire hash over ALL other fields incl executionId. No post-consumption
    // remap/hash shim: the persisted bytes are the consumed bytes.
    // Read-only claims carry no write paths; the wire still needs >=1
    // relevant path, so frozen patch paths (or whole-repo "." when empty)
    // scope the read without inventing new authority.
    const wirePaths =
      view.literalPatchPaths.length > 0 ? view.literalPatchPaths : ["."];
    const unhashed = {
      version: 1,
      executionId: exec,
      configFingerprint: approved.configFingerprint,
      sourceRevision: approved.sourceRevision,
      workspaceAlias: frozenAlias,
      mode: wireModeForReadOnly(view.readOnlyMode),
      purpose: { statement: goalRow.statement, scope: view.scope },
      objective: view.objective,
      relevantPaths: wirePaths,
      acceptance: view.acceptance,
      requiredChecks: view.requiredChecks,
      constraints: [...view.constraints],
      budget: {
        timeoutMs: view.timeoutMs,
        maxOutputBytes: view.maxOutputBytes,
      },
      externalModelConsent: view.possibleExternalDataConsent,
    };
    const taskHash = createHash("sha256")
      .update(wireCanonicalize(unhashed), "utf8")
      .digest("hex");
    const req = parseOr(
      () => TrialLaunchRequestSchema.parse({ ...unhashed, taskHash }),
      "launch request",
    );
    db.prepare(
      "UPDATE trial_grants SET status='claimed', control_generation=?, request_json=?, claimed_at=? WHERE execution_id=?",
    ).run(ctl.version, JSON.stringify(req), now, exec);
    const updated = db
      .prepare("SELECT * FROM trial_grants WHERE execution_id=?")
      .get(exec) as Parameters<typeof toGrantView>[0];
    const body = {
      kind: "result" as const,
      grant: toGrantView(updated),
      request: req,
      applied: true,
    };
    store(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}
function toGrantView(g: {
  execution_id: string;
  proposal_id: string;
  session_id: string;
  scope: string;
  status: string;
  cancel_requested: number;
  control_generation: number;
  created_at: number;
}): {
  executionId: string;
  proposalId: string;
  sessionId: string;
  scope: string;
  status: "queued" | "claimed" | "revoked" | "consumed" | "interrupted";
  cancelRequested: boolean;
  controlGeneration: number;
  createdAt: number;
} {
  return {
    executionId: g.execution_id,
    proposalId: g.proposal_id,
    sessionId: g.session_id,
    scope: g.scope,
    status: g.status as
      | "queued"
      | "claimed"
      | "revoked"
      | "consumed"
      | "interrupted",
    cancelRequested: g.cancel_requested === 1,
    controlGeneration: g.control_generation,
    createdAt: g.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Internal execution lifecycle (Root service only)                     */
/* ------------------------------------------------------------------ */

function requireTicks(t: unknown): string {
  if (typeof t !== "string" || !/^[1-9][0-9]{0,19}$/.test(t))
    throw new RepositoryValidationError(
      "processStartTicks must be canonical decimal TEXT [1-9][0-9]{0,19} (always required, never omitted)",
    );
  return t;
}
/** Active alias fence lookup (global by workspace alias). Fence is active
 * while ANY uncleared row exists for the alias. DB errors throw (fail
 * closed): never masked as "no fence". */
export function activeAliasFence(
  db: Database.Database,
  workspaceAlias: string,
):
  | {
      workspace_alias: string;
      execution_id: string;
      reason: string;
      created_at: number;
    }
  | undefined {
  return db
    .prepare(
      "SELECT workspace_alias, execution_id, reason, created_at FROM trial_alias_fences WHERE workspace_alias=? AND cleared_at IS NULL LIMIT 1",
    )
    .get(workspaceAlias) as
    | {
        workspace_alias: string;
        execution_id: string;
        reason: string;
        created_at: number;
      }
    | undefined;
}
function requireNoActiveFence(
  db: Database.Database,
  workspaceAlias: string,
  op: string,
): void {
  const f = activeAliasFence(db, workspaceAlias);
  if (f)
    throw new RepositoryValidationError(
      `${op} denied: unknown fence active for alias ${workspaceAlias}`,
    );
}
/** Fresh authority deadline: min(proposal expiry, goal valid_until, future
 * matching deny-constraint valid_from). Past/unparseable expiry => 0. */
export function authorityDeadlineMs(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  operation: TrialOperation,
  writePaths: string[],
  workspaceAlias: string,
  proposalExpiry: string,
  now: number,
): number {
  let deadline = parseStrictInstantMs(proposalExpiry) ?? 0;
  try {
    const t = db
      .prepare("SELECT parent_purpose_id FROM autonomy_tasks WHERE id=?")
      .get(taskId) as { parent_purpose_id: string | null } | undefined;
    if (t?.parent_purpose_id) {
      const g = db
        .prepare("SELECT valid_until FROM autonomy_purposes WHERE id=?")
        .get(t.parent_purpose_id) as { valid_until: string | null } | undefined;
      if (g && g.valid_until !== null) {
        const ms = parseStrictInstantMs(g.valid_until);
        if (ms === undefined) return 0;
        deadline = Math.min(deadline, ms);
      }
    }
  } catch {
    return 0;
  }
  // FUTURE explicit user constraints that WILL deny THIS alias/op/paths
  // narrow the deadline to their valid_from; unrelated aliases/ops/paths
  // (or future unstructured HOLDs for other scopes) do not hold this alias.
  try {
    const rows = db
      .prepare(
        "SELECT p.scope AS scope, p.valid_from AS valid_from, r.rule_json AS rule_json FROM autonomy_purposes p LEFT JOIN trial_constraint_rules r ON r.purpose_id=p.id WHERE p.session_id=? AND p.kind='constraint' AND p.status='active' AND p.source_kind='user' AND p.is_explicit=1 AND p.valid_from IS NOT NULL",
      )
      .all(sessionId) as {
      scope: string;
      valid_from: string;
      rule_json: string | null;
    }[];
    const normPaths = writePaths.map((w) => {
      try {
        return assertCanonicalLiteralPath(w, "writePath");
      } catch {
        return null;
      }
    });
    if (normPaths.some((p) => p === null)) return 0;
    for (const row of rows) {
      const ms = parseStrictInstantMs(row.valid_from);
      // Malformed future-constraint timestamps fail closed (immediate
      // deadline): ignoring them would admit runtime past a deny.
      if (ms === undefined) return 0;
      if (ms <= now || ms >= deadline) continue;
      if (row.rule_json === null) {
        // Future unstructured HOLD in the task scope narrows; other scopes irrelevant.
        const t = db
          .prepare("SELECT scope FROM autonomy_tasks WHERE id=?")
          .get(taskId) as { scope: string } | undefined;
        if (t && row.scope === t.scope) deadline = Math.min(deadline, ms);
        continue;
      }
      let rule: {
        denyWorkspace: string[];
        denyOperation: TrialOperation[];
        denyWritePath: { workspaceAlias: string; literalPrefix: string }[];
      };
      try {
        rule = parseConstraintRule(JSON.parse(row.rule_json));
      } catch {
        // Malformed stored rule fails closed as an unstructured HOLD in
        // the task scope: narrow the deadline to its valid_from (mirrors
        // activeConstraints, which HOLDS the same row once it applies).
        const t = db
          .prepare("SELECT scope FROM autonomy_tasks WHERE id=?")
          .get(taskId) as { scope: string } | undefined;
        if (t && row.scope === t.scope) deadline = Math.min(deadline, ms);
        continue;
      }
      const taskScope = (
        db.prepare("SELECT scope FROM autonomy_tasks WHERE id=?").get(taskId) as
          | { scope: string }
          | undefined
      )?.scope;
      if (taskScope === undefined || row.scope !== taskScope) continue;
      let matches =
        rule.denyWorkspace.includes(workspaceAlias) ||
        (rule.denyOperation as string[]).includes(operation);
      if (!matches) {
        for (const d of rule.denyWritePath) {
          if (d.workspaceAlias !== workspaceAlias) continue;
          for (const w of normPaths as string[]) {
            try {
              if (pathIntersectsDenied(w, d.literalPrefix)) {
                matches = true;
                break;
              }
            } catch {
              return 0;
            }
          }
          if (matches) break;
        }
      }
      if (matches) deadline = Math.min(deadline, ms);
    }
  } catch {
    /* ignore: conservative deadline already set */
  }
  return deadline;
}
function requireFitsWindow(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  operation: TrialOperation,
  writePaths: string[],
  workspaceAlias: string,
  proposalExpiry: string,
  timeoutMs: number,
  now: number,
  what: string,
): void {
  const deadline = authorityDeadlineMs(
    db,
    sessionId,
    taskId,
    operation,
    writePaths,
    workspaceAlias,
    proposalExpiry,
    now,
  );
  if (!(deadline > now) || now + timeoutMs > deadline)
    throw new RepositoryValidationError(
      `${what}: full frozen runtime does not fit the known authority window`,
    );
}

/** Persist the known native frontend birth identity BEFORE any payload.
 * REGISTER-ONCE: exact-identity replay idempotent; different identity,
 * revoked/cancelled/unclaimed grant, or session mismatch rejects with zero
 * writes. processStartTicks is canonical decimal TEXT (never wall-clock). */
export function registerWorkerBoot(
  db: Database.Database,
  input: {
    executionId: string;
    sessionId?: string;
    pid: number;
    bootId: string;
    processStartTicks: string;
    observedAt?: number;
    now?: number;
  },
): { executionId: string; pid: number; bootId: string; startedAt: number } {
  const exec = requireId(input.executionId, "executionId");
  const now = nowMs(input.now ?? input.observedAt);
  if (!Number.isInteger(input.pid) || input.pid < 1 || input.pid > 4294967295)
    throw new RepositoryValidationError(
      "pid must be a positive int32-range integer",
    );
  if (
    typeof input.bootId !== "string" ||
    input.bootId.length === 0 ||
    input.bootId.length > 128
  )
    throw new RepositoryValidationError("bootId must be 1..128 chars");
  // Ticks are ALWAYS required: omission never replays, never registers.
  const ticks = requireTicks(input.processStartTicks);
  return withImmediate(db, () => {
    const g = db
      .prepare(
        "SELECT execution_id, session_id, status, cancel_requested, request_json FROM trial_grants WHERE execution_id=?",
      )
      .get(exec) as
      | {
          execution_id: string;
          session_id: string;
          status: string;
          cancel_requested: number;
          request_json: string | null;
        }
      | undefined;
    if (!g) throw new RepositoryNotFoundError(`grant ${exec} not found`);
    if (input.sessionId !== undefined && input.sessionId !== g.session_id)
      throw new RepositoryNotFoundError(
        `grant ${exec} not found in session ${input.sessionId}`,
      );
    if (g.request_json === null)
      throw new RepositoryValidationError(
        "worker boot requires a claimed grant",
      );
    if (
      g.status === "revoked" ||
      g.status === "consumed" ||
      g.status === "interrupted" ||
      g.status === "queued"
    )
      throw new RepositoryValidationError(
        `grant is ${g.status}: no boot registration`,
      );
    if (g.cancel_requested === 1)
      throw new RepositoryValidationError(
        "grant cancel requested: no boot registration",
      );
    const prior = db
      .prepare(
        "SELECT session_id, pid, boot_id, process_start_ticks, observed_at, started_at FROM trial_worker_boots WHERE execution_id=?",
      )
      .get(exec) as
      | {
          session_id: string;
          pid: number;
          boot_id: string;
          process_start_ticks: string;
          observed_at: number;
          started_at: number;
        }
      | undefined;
    if (prior) {
      // Exact replay ONLY when pid + bootId + ticks + session ALL equal.
      if (
        prior.pid === input.pid &&
        prior.boot_id === input.bootId &&
        prior.process_start_ticks === ticks &&
        prior.session_id === (input.sessionId ?? g.session_id)
      )
        return {
          executionId: exec,
          pid: prior.pid,
          bootId: prior.boot_id,
          startedAt: prior.started_at,
        };
      throw new RepositoryValidationError(
        "worker boot identity mismatch: no re-boot/re-arm",
      );
    }
    const sid = input.sessionId ?? g.session_id;
    db.prepare(
      "INSERT INTO trial_worker_boots (execution_id, session_id, pid, boot_id, process_start_ticks, observed_at, started_at) VALUES (?,?,?,?,?,?,?)",
    ).run(exec, sid, input.pid, input.bootId, ticks, now, now);
    return {
      executionId: exec,
      pid: input.pid,
      bootId: input.bootId,
      startedAt: now,
    };
  });
}

/**
 * Trusted runtime observation: a structural trusted-caller argument
 * supplied by the trusted Root service code, never a public body field,
 * never a test-fixture boolean. It is NOT a proof of kernel scope by
 * itself: kernel re-checks authority/profile/fence/boot from the DB. Every
 * field is REQUIRED: omission, NaN, non-integers, and uncanonical ticks
 * are rejected, never defaulted.
 */
export type TrustedObservation = TrustedRuntimeObservation;
function validateObservation(observation: unknown): TrustedRuntimeObservation {
  return parseOr(
    () => TrustedRuntimeObservationSchema.parse(observation),
    "trusted observation",
  );
}

/**
 * One-use launch permit: one ISSUE immediately consumes (consumed_at set).
 * Duplicate/same-key NEVER replays a cached 201: any prior permit or prior
 * stored success for this execution DENIES. Kernel owns fresh DB checks
 * (claimed && !cancel, global pause/generation, owned task/goal authority,
 * expiry/future-deny fit, profile exact, boot identity, fence); the REQUIRED
 * trusted runtime observation supplies ONLY actual scope/frontend/gate
 * liveness plus remaining-runtime/resource props — never DB authority.
 * profile, requestHash, and every observation field are REQUIRED: omission
 * never bypasses a check.
 */
export function issueLaunchPermit(
  db: Database.Database,
  sessionId: string,
  executionId: string,
  deps: {
    key: string;
    now?: number;
    observation: TrustedObservation;
    profile: TrialProfileSnapshot;
    requestHash: string;
  },
): {
  status: number;
  body: {
    permitId: string;
    executionId: string;
    sessionId: string;
    issuedAt: number;
    consumedAt: number;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const key = requireKey(deps.key);
  const now = nowMs(deps.now);
  const profile = profileOrThrow(deps.profile);
  if (
    typeof deps.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(deps.requestHash)
  )
    throw new RepositoryValidationError(
      "requestHash must be a sha256 hex digest",
    );
  const ob = validateObservation(deps.observation);
  const scope = `trial-permit:${exec}`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.claimTrial.operation,
    IDEMPOTENCY_OPERATIONS.claimTrial.schemaVersion,
    {
      op: "trial_launch_permit",
      sessionId: session,
      executionId: exec,
    },
  );
  return withImmediate(db, () => {
    const g = db
      .prepare("SELECT * FROM trial_grants WHERE execution_id=?")
      .get(exec) as
      | {
          execution_id: string;
          proposal_id: string;
          session_id: string;
          scope: string;
          status: string;
          cancel_requested: number;
          control_generation: number;
          request_json: string | null;
          workspace_alias: string | null;
          approved_profile_json: string | null;
        }
      | undefined;
    if (!g || g.session_id !== session)
      throw new RepositoryNotFoundError(
        `grant ${exec} not found in session ${session}`,
      );
    // One-use: a prior permit row OR a prior stored success DENIES (never 201 replay).
    const prior = db
      .prepare(
        "SELECT permit_id FROM trial_launch_permits WHERE execution_id=?",
      )
      .get(exec) as { permit_id: string } | undefined;
    if (prior)
      throw new RepositoryValidationError(
        "launch permit already issued: one-use only",
      );
    const ex = stored(db, scope, key);
    if (ex)
      throw new RepositoryValidationError(
        "launch permit already issued: one-use only",
      );
    if (g.status !== "claimed" || g.request_json === null)
      throw new RepositoryValidationError(
        `grant is ${g.status}: permit requires a claimed grant`,
      );
    if (g.cancel_requested === 1)
      throw new RepositoryValidationError("grant cancel requested: no permit");
    const req = parseOr(
      () =>
        TrialLaunchRequestSchema.parse(JSON.parse(g.request_json as string)),
      "frozen request",
    );
    if (
      deps.requestHash !== undefined &&
      deps.requestHash !== hashTrialRequest(req)
    )
      throw new RepositoryValidationError("request hash mismatch");
    if (req.executionId !== exec)
      throw new RepositoryValidationError("execution id mismatch");
    if (deps.requestHash !== hashTrialRequest(req))
      throw new RepositoryValidationError("request hash mismatch");
    const frozenAlias = g.workspace_alias ?? req.workspaceAlias;
    requireNoActiveFence(db, frozenAlias, "permit");
    const boot = db
      .prepare(
        "SELECT pid, boot_id, process_start_ticks FROM trial_worker_boots WHERE execution_id=?",
      )
      .get(exec) as
      | { pid: number; boot_id: string; process_start_ticks: string }
      | undefined;
    if (!boot)
      throw new RepositoryValidationError(
        "worker boot must be registered before permit",
      );
    const ctl = db
      .prepare("SELECT paused, version FROM autonomy_control WHERE id='global'")
      .get() as { paused: number; version: number };
    if (ctl.paused === 1)
      throw new RepositoryValidationError("paused: no permit");
    {
      const stale = policyGrantFreshness(
        db,
        session,
        exec,
        g.control_generation,
        now,
      );
      if (stale !== null)
        throw new RepositoryValidationError(`policy grant stale: ${stale}`);
    }
    const prow = db
      .prepare("SELECT * FROM trial_proposals WHERE id=?")
      .get(g.proposal_id) as Parameters<typeof toProposalView>[0];
    const view = toProposalView(prow);
    if ((parseStrictInstantMs(view.expiry) ?? NaN) <= now)
      throw new RepositoryValidationError("grant expired");
    const auth = checkTrialAuthority(
      db,
      session,
      view.taskId,
      view.operation,
      view.readOnlyMode ? [] : view.literalPatchPaths,
      frozenAlias,
      now,
    );
    if (
      auth.goalVersion !== view.goalVersion ||
      auth.taskVersion !== view.taskVersion
    )
      throw new RepositoryValidationError("goal/task version drift: no permit");
    // Profile exactness: the REQUIRED trusted arg must equal approved frozen.
    const approved =
      g.approved_profile_json === null
        ? readStagedProfile(db, g.proposal_id)
        : profileOrThrow(
            parseOr(
              () => JSON.parse(g.approved_profile_json as string),
              "approved profile",
            ),
          );
    if (profileBindingKey(profile) !== profileBindingKey(approved))
      throw new RepositoryValidationError("profile drift: no permit");
    // Permit needs OWNED ACTIVE actual runtime + gate open + exact boot identity.
    if (ob.scopeState !== "active")
      throw new RepositoryValidationError("permit requires owned active scope");
    if (ob.frontendSettled)
      throw new RepositoryValidationError(
        "permit requires unsettled live frontend",
      );
    if (!ob.foregroundGateOpen)
      throw new RepositoryValidationError("foreground gate closed: no permit");
    if (
      ob.pid !== boot.pid ||
      ob.bootId !== boot.boot_id ||
      ob.processStartTicks !== boot.process_start_ticks
    )
      throw new RepositoryValidationError(
        "frontend identity mismatch: no permit",
      );
    // Physical fit ALWAYS runs: TX now + remaining must sit within the fresh
    // authority deadline (remaining already validated 1..3600000 int).
    {
      const deadline = authorityDeadlineMs(
        db,
        session,
        view.taskId,
        view.operation,
        view.readOnlyMode ? [] : view.literalPatchPaths,
        frozenAlias,
        view.expiry,
        now,
      );
      if (!(deadline > now) || now + ob.remainingRuntimeMs > deadline)
        throw new RepositoryValidationError(
          "permit denied: physical remaining exceeds authority window",
        );
    }
    if (ob.timeoutMs !== view.timeoutMs)
      throw new RepositoryValidationError(
        "resource props mismatch wire budget",
      );
    if (ob.maxOutputBytes !== view.maxOutputBytes)
      throw new RepositoryValidationError(
        "resource props mismatch wire budget",
      );
    const permitId = generateId();
    db.prepare(
      "INSERT INTO trial_launch_permits (permit_id, execution_id, session_id, issued_at, consumed_at) VALUES (?,?,?,?,?)",
    ).run(permitId, exec, session, now, now);
    const body = {
      permitId,
      executionId: exec,
      sessionId: session,
      issuedAt: now,
      consumedAt: now,
    };
    store(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}
/** Historical permit read (audit only: never new authority). */
export function readLaunchPermit(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): {
  permitId: string;
  executionId: string;
  sessionId: string;
  issuedAt: number;
  consumedAt: number;
} | null {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const row = db
    .prepare(
      "SELECT permit_id, execution_id, session_id, issued_at, consumed_at FROM trial_launch_permits WHERE execution_id=?",
    )
    .get(exec) as
    | {
        permit_id: string;
        execution_id: string;
        session_id: string;
        issued_at: number;
        consumed_at: number;
      }
    | undefined;
  if (!row || row.session_id !== session) return null;
  return {
    permitId: row.permit_id,
    executionId: row.execution_id,
    sessionId: row.session_id,
    issuedAt: row.issued_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Session trial surface projection of one durable worker outcome. `summary`
 * stays for the legacy read consumers; `recorded` separates "no row yet"
 * from a durable false/unauthorized failure, and `succeeded`/`quiescent`/
 * `detail` mirror the actual trial_worker_outcomes row (never inferred from
 * an exit code or grant status).
 */
export interface WorkerOutcomeView {
  status: string;
  authorized: boolean;
  summary: string;
  recorded: boolean;
  succeeded: boolean;
  quiescent: boolean;
  detail: string;
}

/**
 * Pure outcome read for the session trial surface (never mutates): the
 * grant status plus the durable worker outcome row (authorized/succeeded/
 * quiescent flags + fixed bounded detail) for one session-owned execution.
 * Foreign or missing executions return null (the HTTP layer maps to 404).
 */
export function readWorkerOutcome(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): WorkerOutcomeView | null {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const g = db
    .prepare("SELECT session_id, status FROM trial_grants WHERE execution_id=?")
    .get(exec) as { session_id: string; status: string } | undefined;
  if (!g || g.session_id !== session) return null;
  const out = db
    .prepare(
      "SELECT succeeded, quiescent, authorized, detail FROM trial_worker_outcomes WHERE execution_id=?",
    )
    .get(exec) as
    | {
        succeeded: number;
        quiescent: number;
        authorized: number;
        detail: string;
      }
    | undefined;
  if (!out) {
    return {
      status: g.status,
      authorized: false,
      summary: "",
      recorded: false,
      succeeded: false,
      quiescent: false,
      detail: "",
    };
  }
  const summary =
    typeof out.detail === "string" ? out.detail.slice(0, 200) : "";
  return {
    status: g.status,
    authorized: out.authorized === 1,
    summary,
    recorded: true,
    succeeded: out.succeeded === 1,
    quiescent: out.quiescent === 1,
    detail: summary,
  };
}

/**
 * Pure outcome read by proposal (never mutates): the grant bound to one
 * session-owned proposal plus its durable worker outcome row. Null when no
 * grant exists yet (staged proposals) or on foreign/missing rows.
 */
export function readWorkerOutcomeByProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): WorkerOutcomeView | null {
  const session = requireId(sessionId, "sessionId");
  const pid = requireId(proposalId, "proposalId");
  const g = db
    .prepare(
      "SELECT session_id, execution_id, status FROM trial_grants WHERE proposal_id=?",
    )
    .get(pid) as
    | { session_id: string; execution_id: string; status: string }
    | undefined;
  if (!g || g.session_id !== session) return null;
  return readWorkerOutcome(db, session, g.execution_id);
}

/** Bounded sealed-trial report surface. Guest text (summary/findings/
 * unresolved) is presentation-only and unattested; checks/artifact/verified
 * stay host-checked. Oversized values are truncated UTF-8-safely, extra
 * findings/unresolved are dropped (never an authorization input). */
export const TRIAL_REPORT_SUMMARY_MAX_BYTES = 2048;
export const TRIAL_REPORT_FINDING_MAX_BYTES = 1024;
export const TRIAL_REPORT_MAX_FINDINGS = 16;
export const TRIAL_REPORT_MAX_UNRESOLVED = 8;
export const TRIAL_REPORT_MAX_CHECKS = 16;

export interface TrialWorkerCheckView {
  name: string;
  outcome: "passed" | "failed";
  exit: number | null;
}

export interface TrialWorkerReportInput {
  summary: string;
  findings: string[];
  unresolved: string[];
  checks: TrialWorkerCheckView[];
  artifact: { sha256: string; entryCount: number } | null;
  verified: boolean;
}

export interface TrialWorkerReportView extends TrialWorkerReportInput {
  provenance: {
    findings: "guest-reported-unattested";
    checks: "host-checked";
    artifact: "host-checked";
  };
}

const REPORT_PROVENANCE = {
  findings: "guest-reported-unattested",
  checks: "host-checked",
  artifact: "host-checked",
} as const;

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedReportText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  return truncateUtf8Bytes(value.replaceAll("\u0000", ""), maxBytes);
}

/**
 * Validate + bound one already-parsed wire report. Host authority is never
 * derived from these fields; malformed presentation fields degrade to empty
 * values instead of discarding the durable outcome (checks are validated by
 * the bridge proof path separately).
 */
export function normalizeWorkerReport(
  input: unknown,
): TrialWorkerReportInput | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const findingsRaw = Array.isArray(record.findings) ? record.findings : [];
  const unresolvedRaw = Array.isArray(record.unresolved)
    ? record.unresolved
    : [];
  const checksRaw = Array.isArray(record.checks) ? record.checks : [];
  const checks: TrialWorkerCheckView[] = [];
  for (const entry of checksRaw) {
    if (checks.length >= TRIAL_REPORT_MAX_CHECKS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const check = entry as Record<string, unknown>;
    if (
      typeof check.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(check.name) ||
      (check.outcome !== "passed" && check.outcome !== "failed")
    ) {
      continue;
    }
    const exit = check.exit;
    if (
      exit !== null &&
      (typeof exit !== "number" || !Number.isSafeInteger(exit))
    ) {
      continue;
    }
    checks.push({ name: check.name, outcome: check.outcome, exit });
  }
  let artifact: TrialWorkerReportInput["artifact"] = null;
  const rawArtifact = record.artifact;
  if (typeof rawArtifact === "object" && rawArtifact !== null) {
    const a = rawArtifact as Record<string, unknown>;
    if (
      typeof a.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(a.sha256) &&
      typeof a.entryCount === "number" &&
      Number.isSafeInteger(a.entryCount) &&
      a.entryCount >= 0 &&
      a.entryCount <= 1_000_000
    ) {
      artifact = { sha256: a.sha256, entryCount: a.entryCount };
    }
  }
  return {
    summary: boundedReportText(record.summary, TRIAL_REPORT_SUMMARY_MAX_BYTES),
    findings: findingsRaw
      .slice(0, TRIAL_REPORT_MAX_FINDINGS)
      .map((entry) => boundedReportText(entry, TRIAL_REPORT_FINDING_MAX_BYTES)),
    unresolved: unresolvedRaw
      .slice(0, TRIAL_REPORT_MAX_UNRESOLVED)
      .map((entry) => boundedReportText(entry, TRIAL_REPORT_FINDING_MAX_BYTES)),
    checks,
    artifact,
    verified: record.verified === true,
  };
}

function insertWorkerReport(
  db: Database.Database,
  sessionId: string,
  executionId: string,
  report: TrialWorkerReportInput,
  now: number,
): void {
  db.prepare(
    "INSERT INTO trial_worker_reports (execution_id, session_id, summary, findings_json, unresolved_json, checks_json, artifact_json, verified, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    executionId,
    sessionId,
    report.summary,
    JSON.stringify(report.findings),
    JSON.stringify(report.unresolved),
    JSON.stringify(report.checks),
    report.artifact === null ? null : JSON.stringify(report.artifact),
    report.verified ? 1 : 0,
    now,
  );
}

/** Pure report read for the session trial surface (never mutates). */
export function readWorkerReport(
  db: Database.Database,
  sessionId: string,
  executionId: string,
): TrialWorkerReportView | null {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const g = db
    .prepare("SELECT session_id FROM trial_grants WHERE execution_id=?")
    .get(exec) as { session_id: string } | undefined;
  if (!g || g.session_id !== session) return null;
  const row = db
    .prepare(
      "SELECT summary, findings_json, unresolved_json, checks_json, artifact_json, verified FROM trial_worker_reports WHERE execution_id=?",
    )
    .get(exec) as
    | {
        summary: string;
        findings_json: string;
        unresolved_json: string;
        checks_json: string;
        artifact_json: string | null;
        verified: number;
      }
    | undefined;
  if (!row) return null;
  const parseArray = (text: string): unknown[] => {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const normalized = normalizeWorkerReport({
    summary: row.summary,
    findings: parseArray(row.findings_json),
    unresolved: parseArray(row.unresolved_json),
    checks: parseArray(row.checks_json),
    artifact: row.artifact_json === null ? null : JSON.parse(row.artifact_json),
    verified: row.verified === 1,
  });
  if (normalized === null) return null;
  return { ...normalized, provenance: REPORT_PROVENANCE };
}

/** Pure report read by proposal (null before a grant/report exists). */
export function readWorkerReportByProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): TrialWorkerReportView | null {
  const session = requireId(sessionId, "sessionId");
  const pid = requireId(proposalId, "proposalId");
  const g = db
    .prepare(
      "SELECT session_id, execution_id FROM trial_grants WHERE proposal_id=?",
    )
    .get(pid) as { session_id: string; execution_id: string } | undefined;
  if (!g || g.session_id !== session) return null;
  return readWorkerReport(db, session, g.execution_id);
}

/**
 * Record a trusted validated worker result. The result proof (taskHash,
 * exitCode, exact check list vs the frozen requiredChecks, outputMatched,
 * noTimeout) is REQUIRED, as is the typed trusted observation — omission
 * noTimeout) is REQUIRED, as is the typed trusted observation — omission
 * never bypasses the gate. A late revoked-success is NEVER accepted as
 * authorized-done: revoked grants throw instead of marking consumed.
 * Unknown executions cannot be recorded here (use recordQuiescence, which
 * HOLDs the alias). Host-observed facts stay separate from authorized
 * acceptance: `authorized` is true ONLY for a fully verified done; a
 * well-formed but mismatching proof persists observed (authorized=false)
 * without consuming the grant.
 */
export function recordWorkerResult(
  db: Database.Database,
  sessionId: string,
  executionId: string,
  input: {
    detail: string;
    now?: number;
    observation: TrustedObservation;
    result: {
      taskHash: string;
      exitCode: number;
      checks: { id: string; ok: boolean }[];
      outputMatched: boolean;
      noTimeout: boolean;
    };
    report?: TrialWorkerReportInput | null;
  },
): {
  executionId: string;
  outcome: "done" | "quiescent" | "failed" | "observed";
  authorized: boolean;
  recordedAt: number;
} {
  const session = requireId(sessionId, "sessionId");
  const exec = requireId(executionId, "executionId");
  const now = nowMs(input.now);
  if (
    typeof input.detail !== "string" ||
    input.detail.length === 0 ||
    input.detail.length > 2000
  )
    throw new RepositoryValidationError("detail must be 1..2000 chars");
  const ob = validateObservation(input.observation);
  const r = input.result;
  if (typeof r !== "object" || r === null)
    throw new RepositoryValidationError("result proof is required");
  if (typeof r.taskHash !== "string" || !/^[0-9a-f]{64}$/.test(r.taskHash))
    throw new RepositoryValidationError("result taskHash must be sha256 hex");
  if (!Number.isInteger(r.exitCode))
    throw new RepositoryValidationError("result exitCode must be an integer");
  // Empty check sets are recordable but never authorized: the exact-match
  // comparison below (frozen requiredChecks are always 1..16) fails them
  // into observed, preserving the faithful bridge failure (e.g. the capsule
  // failed before checks ran) instead of throwing with no outcome row.
  if (!Array.isArray(r.checks) || r.checks.length > 16)
    throw new RepositoryValidationError(
      "result checks must carry 0..16 entries",
    );
  for (const c of r.checks) {
    if (
      typeof c !== "object" ||
      c === null ||
      typeof (c as { id: unknown }).id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test((c as { id: string }).id) ||
      typeof (c as { ok: unknown }).ok !== "boolean"
    )
      throw new RepositoryValidationError(
        "result checks must be {id matching [A-Za-z0-9_-]{1,64}, ok boolean}",
      );
  }
  if (r.outputMatched !== true && r.outputMatched !== false)
    throw new RepositoryValidationError("result outputMatched must be boolean");
  if (r.noTimeout !== true && r.noTimeout !== false)
    throw new RepositoryValidationError("result noTimeout must be boolean");
  return withImmediate(db, () => {
    const g = db
      .prepare("SELECT * FROM trial_grants WHERE execution_id=?")
      .get(exec) as
      | {
          execution_id: string;
          proposal_id: string;
          session_id: string;
          scope: string;
          status: string;
          cancel_requested: number;
          control_generation: number;
          request_json: string | null;
          workspace_alias: string | null;
          approved_profile_json: string | null;
        }
      | undefined;
    if (!g || g.session_id !== session)
      throw new RepositoryNotFoundError(
        `grant ${exec} not found in session ${session}`,
      );
    // Terminal outcomes immutable: exact duplicate idempotent, conflict 409.
    const prior = db
      .prepare(
        "SELECT succeeded, quiescent, authorized, task_hash, detail, recorded_at FROM trial_worker_outcomes WHERE execution_id=?",
      )
      .get(exec) as
      | {
          succeeded: number;
          quiescent: number;
          authorized: number;
          task_hash: string | null;
          detail: string;
          recorded_at: number;
        }
      | undefined;
    if (prior) {
      const sameBody =
        prior.succeeded === 1 &&
        prior.quiescent === 0 &&
        (prior.task_hash ?? null) === r.taskHash &&
        prior.detail === input.detail;
      if (sameBody) {
        const o = prior.authorized === 1 ? "done" : "observed";
        return {
          executionId: exec,
          outcome: o as "done" | "observed",
          authorized: prior.authorized === 1,
          recordedAt: prior.recorded_at,
        };
      }
      throw new RepositoryValidationError(
        "worker outcome already recorded: immutable",
      );
    }
    if (g.status !== "claimed") {
      // Late provider result after terminal state: persist observed, never authorized.
      db.prepare(
        "INSERT INTO trial_worker_outcomes (execution_id, session_id, succeeded, quiescent, authorized, task_hash, detail, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(exec, session, 1, 0, 0, r.taskHash, input.detail, now);
      const lateReport = normalizeWorkerReport(input.report ?? null);
      if (lateReport !== null && lateReport !== undefined) {
        insertWorkerReport(db, session, exec, lateReport, now);
      }
      return {
        executionId: exec,
        outcome: "observed" as const,
        authorized: false,
        recordedAt: now,
      };
    }
    const req =
      g.request_json === null
        ? null
        : parseOr(
            () =>
              TrialLaunchRequestSchema.parse(
                JSON.parse(g.request_json as string),
              ),
            "frozen request",
          );
    const boot = db
      .prepare(
        "SELECT pid, boot_id, process_start_ticks FROM trial_worker_boots WHERE execution_id=?",
      )
      .get(exec) as
      | { pid: number; boot_id: string; process_start_ticks: string }
      | undefined;
    const permit = db
      .prepare(
        "SELECT permit_id FROM trial_launch_permits WHERE execution_id=?",
      )
      .get(exec) as { permit_id: string } | undefined;
    let authorized = true;
    let reason = "";
    const fail = (m: string) => {
      authorized = false;
      reason = m;
    };
    if (req === null) fail("no frozen request");
    else {
      if (r.taskHash !== req.taskHash) fail("taskHash mismatch");
      if (r.exitCode !== 0) fail("native exit non-zero");
      if (r.outputMatched !== true || r.noTimeout !== true)
        fail("output/timeout mismatch");
      const frozenChecks = [...req.requiredChecks].sort();
      const got = r.checks
        .filter((c) => c.ok)
        .map((c) => c.id)
        .sort();
      if (
        r.checks.length !== frozenChecks.length ||
        !frozenChecks.every((id, i) => got[i] === id) ||
        r.checks.some((c) => !c.ok)
      )
        fail("checks mismatch");
    }
    if (ob.scopeState !== "gone")
      throw new RepositoryValidationError(
        "result requires scope gone (not active)",
      );
    if (!ob.frontendSettled)
      throw new RepositoryValidationError("result requires frontend settled");
    if (!boot)
      throw new RepositoryValidationError(
        "result requires a registered worker boot",
      );
    if (
      ob.pid !== boot.pid ||
      ob.bootId !== boot.boot_id ||
      ob.processStartTicks !== boot.process_start_ticks
    )
      throw new RepositoryValidationError("frontend identity mismatch");
    if (!permit)
      throw new RepositoryValidationError("result requires a permit");
    if (g.cancel_requested === 1) fail("cancel wanted");
    const ctl = db
      .prepare("SELECT paused, version FROM autonomy_control WHERE id='global'")
      .get() as { paused: number; version: number };
    if (ctl.paused === 1) fail("paused");
    {
      const stale = policyGrantFreshness(
        db,
        session,
        exec,
        g.control_generation,
        now,
      );
      if (stale !== null) fail(stale);
    }
    if (req && g.approved_profile_json !== null) {
      try {
        const approved = profileOrThrow(
          parseOr(
            () => JSON.parse(g.approved_profile_json as string),
            "approved profile",
          ),
        );
        if (
          req.configFingerprint !== approved.configFingerprint ||
          req.sourceRevision !== approved.sourceRevision
        )
          fail("profile drift");
      } catch {
        fail("profile unreadable");
      }
    }
    if (req && authorized) {
      try {
        const prow = db
          .prepare("SELECT * FROM trial_proposals WHERE id=?")
          .get(g.proposal_id) as Parameters<typeof toProposalView>[0];
        const view = toProposalView(prow);
        const frozenAlias = g.workspace_alias ?? req.workspaceAlias;
        checkTrialAuthority(
          db,
          session,
          view.taskId,
          view.operation,
          view.readOnlyMode ? [] : view.literalPatchPaths,
          frozenAlias,
          now,
        );
        if ((parseStrictInstantMs(view.expiry) ?? NaN) <= now) fail("expired");
      } catch {
        fail("authority lapsed");
      }
    }
    db.prepare(
      "INSERT INTO trial_worker_outcomes (execution_id, session_id, succeeded, quiescent, authorized, task_hash, detail, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      exec,
      session,
      1,
      0,
      authorized ? 1 : 0,
      r.taskHash,
      authorized
        ? input.detail
        : `observed-not-authorized:${reason}:${input.detail}`.slice(0, 2000),
      now,
    );
    const report = normalizeWorkerReport(input.report ?? null);
    if (report !== null && report !== undefined) {
      insertWorkerReport(db, session, exec, report, now);
    }
    if (authorized) {
      db.prepare(
        "UPDATE trial_grants SET status='consumed' WHERE execution_id=? AND status='claimed'",
      ).run(exec);
      return {
        executionId: exec,
        outcome: "done" as const,
        authorized: true,
        recordedAt: now,
      };
    }
    // Observed (not authorized) after scope gone + frontend settled is
    // terminal: a still-claimed grant leaves 'claimed' for 'interrupted' so
    // it never re-arms and the surface shows a terminal status. Late results
    // on already-terminal grants return above without touching status.
    db.prepare(
      "UPDATE trial_grants SET status='interrupted' WHERE execution_id=? AND status='claimed'",
    ).run(exec);
    return {
      executionId: exec,
      outcome: "observed" as const,
      authorized: false,
      recordedAt: now,
    };
  });
}

/**
 * Quiescence record: a KNOWN execution marks quiescence; an UNKNOWN
 * execution HOLDs the whole alias fence (cannot be cleared by an ordinary
 * claim/retry/profile change — only trusted gone+settled reconciliation of
 * the exact fence row clears it). The unknown path requires the ACTUAL
 * workspace alias AND execution id (never guessed, never generated) plus a
 * validated reason.
 */
export function recordQuiescence(
  db: Database.Database,
  sessionId: string,
  scope: string,
  executionId: string | null,
  now?: number,
  opts?: {
    workspaceAlias: string;
    executionId?: string;
    taskHash?: string | null;
    pid?: number | null;
    bootId?: string | null;
    reason: string;
  },
): { fenced: number } {
  const session = requireId(sessionId, "sessionId");
  const at = nowMs(now);
  if (typeof scope !== "string" || scope.length === 0 || scope.length > 512)
    throw new RepositoryValidationError("scope must be 1..512 chars");
  if (executionId === null) {
    if (!opts || typeof opts.executionId !== "string")
      throw new RepositoryValidationError(
        "unknown quiescence requires opts.executionId (actual id, never generated)",
      );
    return {
      fenced: fenceUnknownExecution(db, session, at, {
        workspaceAlias: opts.workspaceAlias,
        executionId: opts.executionId,
        ...(opts.taskHash !== undefined ? { taskHash: opts.taskHash } : {}),
        ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        ...(opts.bootId !== undefined ? { bootId: opts.bootId } : {}),
        reason: opts.reason,
      }),
    };
  }
  const exec = requireId(executionId, "executionId");
  return withImmediate(db, () => {
    const g = db
      .prepare(
        "SELECT session_id, status FROM trial_grants WHERE execution_id=?",
      )
      .get(exec) as { session_id: string; status: string } | undefined;
    if (!g || g.session_id !== session) {
      if (!opts)
        throw new RepositoryValidationError(
          "unknown quiescence requires opts (actual alias+executionId+reason)",
        );
      return {
        fenced: fenceUnknownExecution(db, session, at, {
          workspaceAlias: opts.workspaceAlias,
          executionId: exec,
          ...(opts.taskHash !== undefined ? { taskHash: opts.taskHash } : {}),
          ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
          ...(opts.bootId !== undefined ? { bootId: opts.bootId } : {}),
          reason: opts.reason,
        }),
      };
    }
    // Known quiescence records terminal cleanup evidence (interrupted) once.
    const prior = db
      .prepare(
        "SELECT execution_id FROM trial_worker_outcomes WHERE execution_id=?",
      )
      .get(exec) as { execution_id: string } | undefined;
    if (!prior) {
      const taskHash = opts?.taskHash ?? null;
      if (
        taskHash !== null &&
        (typeof taskHash !== "string" || !/^[0-9a-f]{64}$/.test(taskHash))
      )
        throw new RepositoryValidationError(
          "taskHash must be sha256 hex or omitted",
        );
      db.prepare(
        "INSERT INTO trial_worker_outcomes (execution_id, session_id, succeeded, quiescent, authorized, task_hash, detail, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        exec,
        session,
        0,
        1,
        0,
        taskHash,
        `known-quiescence:${scope}`.slice(0, 2000),
        at,
      );
    }
    if (g.status === "claimed")
      db.prepare(
        "UPDATE trial_grants SET status='interrupted' WHERE execution_id=?",
      ).run(exec);
    return { fenced: 0 };
  });
}

/**
 * Semantic expiry/validity-boundary reconciliation for the runtime timer
 * (never called by a GET): expires staged proposals past expiry and
 * revokes queued/inflight grants whose proposal expired or whose
 * goal/task authority lapsed. Never auto-revives.
 */
export function reconcileTrialExpiry(
  db: Database.Database,
  now?: number,
): { expired: number; revoked: number } {
  const at = nowMs(now);
  return withImmediate(db, () => {
    const staged = db
      .prepare("SELECT id, expiry FROM trial_proposals WHERE status='staged'")
      .all() as { id: string; expiry: string }[];
    let expired = 0;
    for (const p of staged) {
      const ms = parseStrictInstantMs(p.expiry);
      if (ms === undefined || ms <= at) {
        db.prepare(
          "UPDATE trial_proposals SET status='expired' WHERE id=? AND status='staged'",
        ).run(p.id);
        expired++;
      }
    }
    const grants = db
      .prepare(
        "SELECT g.execution_id AS execution_id, g.status AS status, g.session_id AS session_id, g.scope AS scope, p.task_id AS task_id, p.operation AS operation, p.paths_json AS paths_json, p.expiry AS expiry FROM trial_grants g JOIN trial_proposals p ON p.id=g.proposal_id WHERE g.status IN ('queued','claimed')",
      )
      .all() as {
      execution_id: string;
      status: string;
      session_id: string;
      scope: string;
      task_id: string;
      operation: string;
      paths_json: string;
      expiry: string;
    }[];
    let revoked = 0;
    for (const gr of grants) {
      const expMs = parseStrictInstantMs(gr.expiry);
      let lapse = expMs === undefined || expMs <= at;
      if (!lapse) {
        try {
          const aliasRow = db
            .prepare(
              "SELECT workspace_alias FROM trial_grants WHERE execution_id=?",
            )
            .get(gr.execution_id) as { workspace_alias: string | null };
          // Legacy unbound authority (no frozen alias): FAIL CLOSED, never
          // backfilled from current config.
          if (aliasRow?.workspace_alias == null)
            throw new RepositoryValidationError(
              "unbound legacy grant: no authority",
            );
          const paths = JSON.parse(gr.paths_json) as string[];
          checkTrialAuthority(
            db,
            gr.session_id,
            gr.task_id,
            gr.operation as TrialOperation,
            paths,
            aliasRow.workspace_alias,
            at,
          );
        } catch {
          lapse = true;
        }
      }
      if (lapse) {
        if (gr.status === "queued") {
          db.prepare(
            "UPDATE trial_grants SET status='revoked' WHERE execution_id=?",
          ).run(gr.execution_id);
        } else {
          db.prepare(
            "UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?",
          ).run(gr.execution_id);
        }
        revoked++;
      }
    }
    return { expired, revoked };
  });
}

/** Invalidate affected queued+inflight grants (never revive); unrelated alias continues. */
export function invalidateTrialsForScope(
  db: Database.Database,
  sessionId: string,
  scope: string,
  reason: string,
  now: number,
): number {
  const rows = db
    .prepare(
      "SELECT execution_id, status FROM trial_grants WHERE session_id=? AND scope=? AND status IN ('queued','claimed')",
    )
    .all(sessionId, scope) as { execution_id: string; status: string }[];
  let n = 0;
  for (const r of rows) {
    if (r.status === "queued") {
      db.prepare(
        "UPDATE trial_grants SET status='revoked' WHERE execution_id=?",
      ).run(r.execution_id);
    } else {
      db.prepare(
        "UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?",
      ).run(r.execution_id);
    }
    n++;
  }
  void reason;
  void now;
  return n;
}
/** STOP: pause first + revoke CLAIMED/inflight and cancelRequested. */
export function revokeAllClaimedForStop(
  db: Database.Database,
  now: number,
): number {
  // QUEUED-unconsumed grants SURVIVE pause/restart (claim gated on fresh
  // explicit resume); only CLAIMED inflight is revoked + cancelRequested.
  const rows = db
    .prepare("SELECT execution_id FROM trial_grants WHERE status='claimed'")
    .all() as { execution_id: string }[];
  for (const r of rows) {
    db.prepare(
      "UPDATE trial_grants SET status='revoked', cancel_requested=1 WHERE execution_id=?",
    ).run(r.execution_id);
  }
  void now;
  return rows.length;
}
/** Unknown execution persists a durable per-(ALIAS, execution) fence row
 * (global by alias): original execution/hash/identity/reason recorded; one
 * row PER (alias, executionId) so a second unknown on the same alias keeps
 * the fence after the first row clears. Queued grants for THAT alias are
 * revoked, claimed flagged cancel_wanted; unrelated aliases untouched. New
 * grants/profile changes/restarts cannot clear; only trusted gone+settled
 * reconciliation of the EXACT row clears it. Alias and executionId are both
 * REQUIRED (never guessed from scope, never generated); reason is REQUIRED
 * bounded text (rejected when invalid, never truncated). Returns the real
 * count of grants revoked/flagged. */
export function fenceUnknownExecution(
  db: Database.Database,
  sessionId: string,
  now: number,
  opts: {
    workspaceAlias: string;
    executionId: string;
    taskHash?: string | null;
    pid?: number | null;
    bootId?: string | null;
    reason: string;
  },
): number {
  const at = nowMs(now);
  requireSession(db, sessionId);
  const alias = assertWorkspaceAlias(opts.workspaceAlias, "workspaceAlias");
  const execId = requireId(opts.executionId, "executionId");
  const taskHash = opts.taskHash ?? null;
  if (
    taskHash !== null &&
    (typeof taskHash !== "string" || !/^[0-9a-f]{64}$/.test(taskHash))
  )
    throw new RepositoryValidationError(
      "fence taskHash must be sha256 hex or omitted",
    );
  const pid = opts.pid ?? null;
  if (pid !== null && (!Number.isInteger(pid) || pid < 1 || pid > 4294967295))
    throw new RepositoryValidationError(
      "fence pid must be a positive int32-range integer or omitted",
    );
  const bootId = opts.bootId ?? null;
  if (
    bootId !== null &&
    (typeof bootId !== "string" || bootId.length === 0 || bootId.length > 128)
  )
    throw new RepositoryValidationError(
      "fence bootId must be 1..128 chars or omitted",
    );
  if (
    typeof opts.reason !== "string" ||
    opts.reason.length === 0 ||
    opts.reason.length > 256 ||
    !/^[A-Za-z0-9_.: /=-]{1,256}$/.test(opts.reason)
  )
    throw new RepositoryValidationError(
      "fence reason must be 1..256 chars of [A-Za-z0-9_.: /=-] (rejected, never truncated)",
    );
  const run = (): number => {
    const prior = db
      .prepare(
        "SELECT workspace_alias FROM trial_alias_fences WHERE workspace_alias=? AND execution_id=? AND cleared_at IS NULL",
      )
      .get(alias, execId) as { workspace_alias: string } | undefined;
    if (!prior) {
      db.prepare(
        "INSERT INTO trial_alias_fences (workspace_alias, execution_id, task_hash, pid, boot_id, reason, created_at, cleared_at) VALUES (?,?,?,?,?,?,?,NULL)",
      ).run(alias, execId, taskHash, pid, bootId, opts.reason, at);
    }
    // Revoke/flag ONLY grants bound to this alias (unrelated alias B survives).
    const rows = db
      .prepare(
        "SELECT execution_id, status FROM trial_grants WHERE workspace_alias=? AND status IN ('queued','claimed')",
      )
      .all(alias) as { execution_id: string; status: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.status === "queued")
        db.prepare(
          "UPDATE trial_grants SET status='revoked' WHERE execution_id=?",
        ).run(r.execution_id);
      else
        db.prepare(
          "UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?",
        ).run(r.execution_id);
      n++;
    }
    return n;
  };
  if ((db as unknown as { inTransaction: boolean }).inTransaction) return run();
  return withImmediate(db, run);
}
/** Trusted clearing of ONE exact fence row: requires the row's executionId
 * plus a validated trusted observation for THAT execution (scopeState gone,
 * frontendSettled true). Clears only that row; the alias fence lifts only
 * when no uncleared rows remain. A wrong executionId rejects with zero
 * writes. No human boolean force-clear, no recovered-PID kill. */
export function clearAliasFence(
  db: Database.Database,
  workspaceAlias: string,
  executionId: string,
  observation: TrustedObservation,
): number {
  assertWorkspaceAlias(workspaceAlias, "workspaceAlias");
  const exec = requireId(executionId, "executionId");
  const ob = validateObservation(observation);
  if (ob.scopeState !== "gone" || ob.frontendSettled !== true)
    throw new RepositoryValidationError(
      "fence clear requires trusted scope gone + frontend settled",
    );
  return withImmediate(db, () => {
    const row = db
      .prepare(
        "SELECT workspace_alias FROM trial_alias_fences WHERE workspace_alias=? AND execution_id=? AND cleared_at IS NULL",
      )
      .get(workspaceAlias, exec) as { workspace_alias: string } | undefined;
    if (!row)
      throw new RepositoryValidationError(
        "no active fence row for (alias, executionId): clear rejected",
      );
    db.prepare(
      "UPDATE trial_alias_fences SET cleared_at=? WHERE workspace_alias=? AND execution_id=? AND cleared_at IS NULL",
    ).run(ob.observedAt, workspaceAlias, exec);
    return 1;
  });
}
/** Explicit expire/invalidate command (pure GETs never write expiry). */
export function expireTrialProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  now: number,
): void {
  withImmediate(db, () => {
    const p = db
      .prepare("SELECT session_id, status FROM trial_proposals WHERE id=?")
      .get(proposalId) as { session_id: string; status: string } | undefined;
    if (!p || p.session_id !== sessionId)
      throw new RepositoryNotFoundError(`proposal ${proposalId} not found`);
    if (p.status === "staged")
      db.prepare("UPDATE trial_proposals SET status='expired' WHERE id=?").run(
        proposalId,
      );
    const g = db
      .prepare(
        "SELECT execution_id, status FROM trial_grants WHERE proposal_id=?",
      )
      .get(proposalId) as { execution_id: string; status: string } | undefined;
    if (g && g.status === "queued")
      db.prepare(
        "UPDATE trial_grants SET status='revoked' WHERE execution_id=?",
      ).run(g.execution_id);
    void now;
  });
}

/* ------------------------------------------------------------------ */
/* Runner reads (pure SELECT, no writes): oldest queued grant per alias */
/* and claimed grants carrying a worker boot row (for boot recovery).  */
/* ------------------------------------------------------------------ */

export interface QueuedTrialGrant {
  executionId: string;
  sessionId: string;
  scope: string;
  createdAt: number;
  proposalId: string;
}

/** Stable oldest-first cursor: (created_at, execution_id) total order. */
export interface QueuedTrialGrantCursor {
  createdAt: number;
  executionId: string;
}

interface QueuedGrantRow {
  execution_id: string;
  session_id: string;
  scope: string;
  created_at: number;
  proposal_id: string;
}

function toQueuedGrant(r: QueuedGrantRow): QueuedTrialGrant {
  return {
    executionId: r.execution_id,
    sessionId: r.session_id,
    scope: r.scope,
    createdAt: r.created_at,
    proposalId: r.proposal_id,
  };
}

/**
 * Oldest queued grants bound to an alias (fail closed on bad alias).
 *
 * Optional `after` is an EXCLUSIVE keyset cursor and `through` is an INCLUSIVE
 * snapshot boundary, both in the same `(created_at, execution_id)` total order
 * as the returned array. This lets one runner pick page past permanently
 * blocked heads without re-reading them, while `through` freezes the cohort
 * that existed when the pick started (new arrivals wait for the next poll and
 * can never extend one pick without bound).
 */
export function listQueuedTrialGrants(
  db: Database.Database,
  workspaceAlias: string,
  limit = 1,
  after?: QueuedTrialGrantCursor,
  through?: QueuedTrialGrantCursor,
): QueuedTrialGrant[] {
  const alias = assertWorkspaceAlias(workspaceAlias, "workspaceAlias");
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  let sql =
    "SELECT execution_id, session_id, scope, created_at, proposal_id FROM trial_grants WHERE status='queued' AND workspace_alias=?";
  const params: Array<string | number> = [alias];
  if (after !== undefined) {
    sql += " AND (created_at > ? OR (created_at = ? AND execution_id > ?))";
    params.push(after.createdAt, after.createdAt, after.executionId);
  }
  if (through !== undefined) {
    sql += " AND (created_at < ? OR (created_at = ? AND execution_id <= ?))";
    params.push(through.createdAt, through.createdAt, through.executionId);
  }
  sql += " ORDER BY created_at ASC, execution_id ASC LIMIT ?";
  params.push(capped);
  const rows = db.prepare(sql).all(...params) as QueuedGrantRow[];
  return rows.map(toQueuedGrant);
}

/**
 * Newest queued grants' keyset cursor, or null when the alias queue is empty.
 * Pure SELECT: the runner uses it as the inclusive snapshot boundary for one
 * pick so a continuously refilled tail cannot extend that pick.
 */
export function readQueuedTrialGrantHorizon(
  db: Database.Database,
  workspaceAlias: string,
): QueuedTrialGrantCursor | null {
  const alias = assertWorkspaceAlias(workspaceAlias, "workspaceAlias");
  const row = db
    .prepare(
      "SELECT execution_id, created_at FROM trial_grants WHERE status='queued' AND workspace_alias=? ORDER BY created_at DESC, execution_id DESC LIMIT 1",
    )
    .get(alias) as { execution_id: string; created_at: number } | undefined;
  return row === undefined
    ? null
    : { createdAt: row.created_at, executionId: row.execution_id };
}

export interface ClaimedTrialWorker {
  executionId: string;
  sessionId: string;
  scope: string;
  workspaceAlias: string | null;
  pid: number;
  bootId: string;
  processStartTicks: string;
}

/** Claimed grants with a registered worker boot row (recovery scan). */
export function listClaimedTrialWorkers(
  db: Database.Database,
): ClaimedTrialWorker[] {
  const rows = db
    .prepare(
      "SELECT g.execution_id AS execution_id, g.session_id AS session_id, g.scope AS scope, g.workspace_alias AS workspace_alias, b.pid AS pid, b.boot_id AS boot_id, b.process_start_ticks AS process_start_ticks FROM trial_grants g JOIN trial_worker_boots b ON b.execution_id=g.execution_id WHERE g.status='claimed' ORDER BY g.created_at ASC",
    )
    .all() as {
    execution_id: string;
    session_id: string;
    scope: string;
    workspace_alias: string | null;
    pid: number;
    boot_id: string;
    process_start_ticks: string;
  }[];
  return rows.map((r) => ({
    executionId: r.execution_id,
    sessionId: r.session_id,
    scope: r.scope,
    workspaceAlias: r.workspace_alias,
    pid: r.pid,
    bootId: r.boot_id,
    processStartTicks: r.process_start_ticks,
  }));
}
