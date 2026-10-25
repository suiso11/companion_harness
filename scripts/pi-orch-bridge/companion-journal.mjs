// Minimal one-use SQLite journal for the sealed bridge. Node 24 node:sqlite
// only. The journal stores the exact canonical request, one owner token hash,
// and the final bounded result/artifact. Final outcomes are immutable; a
// duplicate while inflight is unknown/no-resend; a duplicate final is replayed
// verbatim without any source/config re-check.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, companionScopeUnit } from "./companion-protocol.mjs";

const DB_FILENAME = "companion-journal.db";
const PAGE_SIZE = 4096;
const HEADROOM = 64 * 1024;

function fail(message) {
  throw new Error(`companion-journal: ${message}`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function needPositiveInt(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`storage policy ${field} must be a positive integer`);
  }
  return value;
}

export function validateStoragePolicy(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("storage policy must be an object");
  const allowed = ["maxRequestBytes", "maxArtifactBytes", "maxResultBytes", "maxDbBytes"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(`storage policy carries an unsupported key: ${key}`);
  }
  const out = {};
  for (const key of allowed) {
    if (!(key in raw)) fail(`storage policy is missing field: ${key}`);
    out[key] = needPositiveInt(raw[key], key);
  }
  if (out.maxDbBytes < 2 * 1024 * 1024) fail("storage policy maxDbBytes is too small");
  return out;
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) fail("stateDir is not a private directory");
  if ((st.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
  }
}

export class CompanionJournal {
  constructor(stateDir, storage) {
    this.stateDir = stateDir;
    this.storage = storage;
    this.dbPath = join(stateDir, DB_FILENAME);
    ensurePrivateDir(stateDir);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=DELETE");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA max_page_count=1048576");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trials (
        execution_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL,
        owner_token_hash TEXT,
        result_json TEXT,
        exit_code INTEGER,
        artifact_sha256 TEXT,
        artifact_bytes BLOB,
        config_fingerprint TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        workspace_alias TEXT NOT NULL,
        scope_unit TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    try {
      chmodSync(this.dbPath, 0o600);
    } catch {
      // The DB was just created; chmod best effort.
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Best effort.
    }
  }

  reserve(request, active, caps) {
    const requestJson = canonicalize(request);
    const requestHash = sha256(requestJson);
    const artifactCap = needPositiveInt(caps.artifactCapBytes, "artifactCapBytes");
    const resultCap = needPositiveInt(caps.resultCapBytes, "resultCapBytes");
    const need = Buffer.byteLength(requestJson) + artifactCap + resultCap + HEADROOM;
    if (2 * need + HEADROOM > this.storage.maxDbBytes) {
      fail("request/artifact/result capacity exceeds maxDbBytes");
    }
    const row = this.db
      .prepare("SELECT request_hash, state, result_json, exit_code FROM trials WHERE execution_id = ?")
      .get(request.executionId);
    if (row !== undefined) {
      if (row.request_hash !== requestHash) fail("executionId conflicts with a different request body");
      if (row.state !== "inflight") {
        if (typeof row.result_json !== "string" || typeof row.exit_code !== "number") {
          fail("stored final row is incomplete");
        }
        return { kind: "duplicate-final", resultJsonLf: row.result_json, exitCode: row.exit_code };
      }
      return { kind: "duplicate-inflight", scopeUnit: companionScopeUnit(request) };
    }
    const ownerToken = randomBytes(32).toString("hex");
    const ownerHash = sha256(ownerToken);
    const scopeUnit = companionScopeUnit(request);
    this.db
      .prepare(
        `INSERT INTO trials
          (execution_id, request_hash, request_json, state, owner_token_hash,
           result_json, exit_code, artifact_sha256, artifact_bytes,
           config_fingerprint, source_revision, workspace_alias, scope_unit, created_at)
         VALUES (?, ?, ?, 'inflight', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.executionId,
        requestHash,
        requestJson,
        ownerHash,
        active.configFingerprint,
        active.sourceRevision,
        active.workspaceAlias,
        scopeUnit,
        Date.now(),
      );
    return { kind: "owner", ownerToken, scopeUnit };
  }

  finalize(request, input) {
    const ownerHash = sha256(input.ownerToken);
    const row = this.db
      .prepare("SELECT state, owner_token_hash, result_json, exit_code FROM trials WHERE execution_id = ?")
      .get(request.executionId);
    if (row === undefined) fail("executionId was never reserved");
    if (row.state !== "inflight") {
      if (typeof row.result_json === "string" && typeof row.exit_code === "number") {
        return { kind: "duplicate-final", resultJsonLf: row.result_json, exitCode: row.exit_code };
      }
      fail("final row is incomplete");
    }
    if (row.owner_token_hash !== ownerHash) fail("owner token does not own this reservation");
    const resultBytes = Buffer.byteLength(input.resultJsonLf);
    if (resultBytes > this.storage.maxResultBytes) fail("final result exceeds the storage result cap");
    let artifactSha = null;
    let artifactBytes = null;
    if (input.artifactBytes !== undefined) {
      if (input.artifactBytes.length > this.storage.maxArtifactBytes) fail("artifact exceeds the storage artifact cap");
      artifactBytes = Buffer.from(input.artifactBytes);
      artifactSha = createHash("sha256").update(artifactBytes).digest("hex");
    }
    const state =
      input.exitCode === 0
        ? "done"
        : input.exitCode === 143
          ? "cancelled"
          : input.exitCode === 1
            ? "unknown"
            : "error";
    this.db
      .prepare(
        `UPDATE trials
           SET state = ?, result_json = ?, exit_code = ?, artifact_sha256 = ?, artifact_bytes = ?
         WHERE execution_id = ? AND state = 'inflight'`,
      )
      .run(state, input.resultJsonLf, input.exitCode, artifactSha, artifactBytes, request.executionId);
    return { kind: "owner" };
  }

  inspect(executionId) {
    const row = this.db
      .prepare(
        `SELECT execution_id, state, scope_unit, config_fingerprint, source_revision,
                workspace_alias, exit_code, result_json, artifact_sha256
           FROM trials WHERE execution_id = ?`,
      )
      .get(executionId);
    if (row === undefined) return undefined;
    return {
      executionId: row.execution_id,
      state: row.state,
      scopeUnit: row.scope_unit,
      configFingerprint: row.config_fingerprint,
      sourceRevision: row.source_revision,
      workspaceAlias: row.workspace_alias,
      exitCode: row.exit_code,
      hasResult: typeof row.result_json === "string",
      artifactSha256: row.artifact_sha256,
    };
  }

  readArtifact(executionId) {
    const row = this.db
      .prepare("SELECT artifact_bytes, artifact_sha256 FROM trials WHERE execution_id = ?")
      .get(executionId);
    if (row === undefined || row.artifact_bytes === null || typeof row.artifact_sha256 !== "string") {
      return undefined;
    }
    const bytes = Buffer.from(row.artifact_bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== row.artifact_sha256) fail("stored artifact digest mismatch");
    return { bytes, sha256: digest };
  }
}
