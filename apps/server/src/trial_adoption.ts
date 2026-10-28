// Human-clicked adoption of a verified write-trial candidate.
//
// After a human reviewed the retained candidate, this module materializes
// exactly those bytes onto a detached worktree of the frozen base ref, commits
// with fixed provenance, pushes a trial/* branch, and opens a DRAFT pull
// request. It never merges, never pushes to the base branch, never force
// pushes, and never changes file modes. Every child process is spawned
// without a shell, with fixed args, a bounded timeout, and a minimal env.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TrialAdoptionConfig } from "./config.js";

export type TrialAdoptionErrorCode =
  | "adoption_disabled"
  | "not_verified"
  | "artifact_mismatch"
  | "base_changed"
  | "branch_exists"
  | "git_failed"
  | "gh_failed";

export class TrialAdoptionError extends Error {
  readonly code: TrialAdoptionErrorCode;
  constructor(code: TrialAdoptionErrorCode) {
    super(code);
    this.name = "TrialAdoptionError";
    this.code = code;
  }
}

export interface TrialAdoptionFileInput {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly baseSha256: string | null;
  readonly candidateBytes: Buffer | null;
}

export interface ExecuteTrialAdoptionInput {
  readonly config: TrialAdoptionConfig;
  readonly executionId: string;
  readonly artifactSha256: string;
  readonly objective: string;
  readonly files: readonly TrialAdoptionFileInput[];
}

export interface TrialAdoptionResult {
  readonly branch: string;
  readonly prUrl: string;
}

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMIT_NAME = "Companion trial";
const COMMIT_EMAIL = "noreply@companion.local";
const PR_BODY =
  "Human review required; created from a sealed trial.\n\nThis draft was created only after a human reviewed the verified diff.";

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  if (process.env.XDG_CONFIG_HOME !== undefined) {
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  }
  if (process.env.XDG_CACHE_HOME !== undefined) {
    env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  }
  return env;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      env: minimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_BYTES) return current;
      return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ProcResult> {
  return run(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args],
    cwd,
    timeoutMs,
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(path: string): string[] {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new TrialAdoptionError("not_verified");
  }
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    throw new TrialAdoptionError("not_verified");
  }
  return segments;
}

function escapeRefComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function commitSubject(objective: string): string {
  const line = objective.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = line.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? "trial" : trimmed.slice(0, 60);
}

function branchBaseName(baseRef: string, remote: string): string {
  const prefix = `${remote}/`;
  const name = baseRef.startsWith(prefix)
    ? baseRef.slice(prefix.length)
    : baseRef;
  if (name.length === 0 || name.includes("..") || name.startsWith("/")) {
    throw new TrialAdoptionError("git_failed");
  }
  return name;
}

function parsePrUrl(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(https:\/\/[^\s]+)$/.exec(line.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Boot recovery helper: drop stale metadata for temp worktrees removed by
 * the OS tmp cleanup. Best effort; failures are swallowed (never startup). */
export async function pruneTrialAdoptionWorktrees(
  repoPath: string,
): Promise<void> {
  try {
    await git(repoPath, ["worktree", "prune"]);
  } catch {
    // Best effort: a missing/broken checkout never blocks startup.
  }
}

/** Execute one adoption attempt. Throws TrialAdoptionError with a fixed code;
 * always removes the temporary worktree. Never touches the base branch. */
export async function executeTrialAdoption(
  input: ExecuteTrialAdoptionInput,
): Promise<TrialAdoptionResult> {
  const { config } = input;
  const branch = `${config.branchPrefix}${escapeRefComponent(
    input.executionId.slice(0, 8),
  )}`;
  const baseBranch = branchBaseName(config.baseRef, config.remote);
  const worktree = mkdtempSync(join(tmpdir(), "companion-adoption-"));
  let worktreeAdded = false;
  try {
    const fetched = await git(config.repoPath, ["fetch", config.remote]);
    if (fetched.code !== 0) throw new TrialAdoptionError("git_failed");
    const baseRev = await git(config.repoPath, [
      "rev-parse",
      "--verify",
      `${config.baseRef}^{commit}`,
    ]);
    if (baseRev.code !== 0) throw new TrialAdoptionError("git_failed");

    const added = await git(config.repoPath, [
      "worktree",
      "add",
      "--detach",
      worktree,
      config.baseRef,
    ]);
    if (added.code !== 0) throw new TrialAdoptionError("git_failed");
    worktreeAdded = true;

    const localExists = await git(worktree, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    const remoteExists = await git(config.repoPath, [
      "ls-remote",
      "--heads",
      config.remote,
      `refs/heads/${branch}`,
    ]);
    if (remoteExists.code !== 0) throw new TrialAdoptionError("git_failed");
    if (localExists.code === 0 || remoteExists.stdout.trim().length > 0) {
      throw new TrialAdoptionError("branch_exists");
    }

    for (const file of input.files) {
      const segments = safeRelativePath(file.path);
      const target = join(worktree, ...segments);
      if (file.kind === "create") {
        const existing = lstatSync(target, { throwIfNoEntry: false });
        if (existing !== undefined)
          throw new TrialAdoptionError("base_changed");
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        writeFileSync(target, file.candidateBytes ?? Buffer.alloc(0), {
          mode: 0o644,
        });
        chmodSync(target, 0o644);
        continue;
      }
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) {
        throw new TrialAdoptionError("base_changed");
      }
      const baseBytes = readFileSync(target);
      if (file.baseSha256 === null || sha256(baseBytes) !== file.baseSha256) {
        throw new TrialAdoptionError("base_changed");
      }
      if (file.kind === "modify") {
        if (file.candidateBytes === null) {
          throw new TrialAdoptionError("not_verified");
        }
        const baseMode = statSync(target).mode & 0o777;
        writeFileSync(target, file.candidateBytes);
        // Preserve the base mode exactly; candidates never alter modes.
        chmodSync(target, baseMode);
      } else {
        rmSync(target);
      }
    }

    const added2 = await git(worktree, ["add", "-A"]);
    if (added2.code !== 0) throw new TrialAdoptionError("git_failed");
    const message = `trial: ${commitSubject(input.objective)}\n\nTrial-Execution: ${input.executionId}\nArtifact-Sha256: ${input.artifactSha256}`;
    const committed = await git(worktree, [
      "-c",
      `user.name=${COMMIT_NAME}`,
      "-c",
      `user.email=${COMMIT_EMAIL}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    if (committed.code !== 0) throw new TrialAdoptionError("git_failed");

    const pushed = await git(
      worktree,
      ["push", config.remote, `HEAD:refs/heads/${branch}`],
      PUSH_TIMEOUT_MS,
    );
    if (pushed.code !== 0) {
      // A rejected push is nearly always a raced branch creation.
      const exists = await git(config.repoPath, [
        "ls-remote",
        "--heads",
        config.remote,
        `refs/heads/${branch}`,
      ]);
      throw new TrialAdoptionError(
        exists.code === 0 && exists.stdout.trim().length > 0
          ? "branch_exists"
          : "git_failed",
      );
    }

    const title = `trial: ${commitSubject(input.objective)}`;
    const created = await run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        baseBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        PR_BODY,
      ],
      worktree,
      GH_TIMEOUT_MS,
    );
    if (created.code !== 0) throw new TrialAdoptionError("gh_failed");
    const prUrl = parsePrUrl(created.stdout);
    if (prUrl === null) throw new TrialAdoptionError("gh_failed");
    return { branch, prUrl };
  } finally {
    if (worktreeAdded) {
      await git(config.repoPath, ["worktree", "remove", "--force", worktree]);
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}
