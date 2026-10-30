// Human-clicked adoption of a verified write-trial candidate.
//
// After a human reviewed the retained candidate, this module materializes
// exactly those bytes onto a detached worktree of the frozen base ref, commits
// with fixed provenance, pushes a trial/* branch, and opens a DRAFT pull
// request. It never merges, never pushes to the base branch, never force
// pushes, and never changes file modes. Every child process is spawned
// without a shell, with fixed args, a bounded timeout, and a minimal env.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** Base commit recorded by the attempt that pushed. When set, resume
   * rebuilds and validates the expected tree against exactly this snapshot,
   * never against a base ref that may have advanced since. */
  readonly baseSha?: string | null;
  /** Called once the base commit is fixed, before any worktree mutation, so
   * the caller can persist it for a later resume. */
  readonly onBaseSha?: (baseSha: string) => void;
  /** false = keep the commit on a LOCAL branch (no push, no PR). */
  readonly push?: boolean;
}

export interface TrialAdoptionResult {
  readonly branch: string;
  /** null for a local-only apply (no push, no PR). */
  readonly prUrl: string | null;
  readonly commitSha: string;
  readonly baseSha: string;
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

/** Token/host env is forwarded to the `gh` invocation only. Never pass this
 * to git: the credentials must not leak into repository commands or logs. */
export function ghEnvironment(): NodeJS.ProcessEnv {
  const env = minimalEnv();
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Kill the whole process group: a wrapper script (or any child that forks)
 * can leave grandchildren holding the stdout pipe open past our own child. */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Bounded child runner. The child is its own process-group leader so a
 * timeout can kill every descendant; after a kill we settle on the child's
 * "exit" (not the pipe "close") because a surviving grandchild may hold the
 * pipes open forever. Exported for the timeout regression test. */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = minimalEnv(),
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup(child);
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
    child.on("error", () => settle(null));
    child.on("exit", (code) => {
      if (timedOut) settle(code);
    });
    child.on("close", (code) => settle(code));
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ProcResult> {
  return runCommand(
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

/** Reject symlinked ancestors so a base-tree symlink can never redirect a
 * mutation outside the temporary worktree. Missing directories are created
 * one level at a time, re-checking each with lstat. */
function prepareParentDirectories(
  worktree: string,
  segments: readonly string[],
): void {
  for (let i = 0; i < segments.length - 1; i += 1) {
    const dir = join(worktree, ...segments.slice(0, i + 1));
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        mkdirSync(dir, { mode: 0o755 });
      } catch {
        throw new TrialAdoptionError("base_changed");
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TrialAdoptionError("base_changed");
    }
  }
}

/** Resolve a GitHub remote URL to the owner/repo slug gh needs, so PR
 * creation targets the configured adoption remote rather than gh's default. */
function parseGithubRepo(url: string): string | null {
  const normalized = url.trim().replace(/\/+$/, "");
  const match =
    /^(?:git@|ssh:\/\/git@|https:\/\/)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(
      normalized,
    );
  if (match === null) return null;
  const host = match[1];
  const owner = match[2];
  const repo = match[3];
  if (host === undefined || owner === undefined || repo === undefined) {
    return null;
  }
  if (host.toLowerCase() !== "github.com") return null;
  return `${owner}/${repo}`;
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
    // A resume must use the base recorded by the original attempt, not the
    // freshly fetched tip: the base branch may have advanced after the push.
    const requestedBase =
      input.baseSha === undefined || input.baseSha === null
        ? null
        : input.baseSha;
    if (requestedBase !== null && !/^[0-9a-f]{40,64}$/.test(requestedBase)) {
      throw new TrialAdoptionError("git_failed");
    }
    const baseRev = await git(config.repoPath, [
      "rev-parse",
      "--verify",
      `${requestedBase ?? config.baseRef}^{commit}`,
    ]);
    if (baseRev.code !== 0) throw new TrialAdoptionError("git_failed");
    const baseCommit = baseRev.stdout.trim();
    if (requestedBase !== null && baseCommit !== requestedBase) {
      throw new TrialAdoptionError("git_failed");
    }
    input.onBaseSha?.(baseCommit);

    const added = await git(config.repoPath, [
      "worktree",
      "add",
      "--detach",
      worktree,
      baseCommit,
    ]);
    if (added.code !== 0) throw new TrialAdoptionError("git_failed");
    worktreeAdded = true;

    const localExists = await git(worktree, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    const push = input.push !== false;
    const remoteExists = push
      ? await git(config.repoPath, [
          "ls-remote",
          "--heads",
          config.remote,
          `refs/heads/${branch}`,
        ])
      : { code: 1, stdout: "" };
    if (push && remoteExists.code !== 0)
      throw new TrialAdoptionError("git_failed");

    // Resume is allowed only when the existing branch is provably the commit
    // this exact execution pushed (same execution id and artifact digest), so
    // a failure after the push can retry PR creation without re-pushing.
    let existingRef: string | null = null;
    if (remoteExists.stdout.trim().length > 0) {
      const fetchedBranch = await git(worktree, [
        "fetch",
        "--no-tags",
        config.remote,
        `refs/heads/${branch}`,
      ]);
      if (fetchedBranch.code !== 0) throw new TrialAdoptionError("git_failed");
      existingRef = "FETCH_HEAD";
    } else if (localExists.code === 0) {
      existingRef = `refs/heads/${branch}`;
    }
    // Materialize the reviewed bytes in every case: a resume must rebuild the
    // exact expected tree before it may trust an existing branch. Deletions
    // run first so a directory can be replaced by a file at the same path.
    const keptDirs = new Set<string>();
    for (const file of input.files) {
      if (file.kind === "delete") continue;
      const segments = safeRelativePath(file.path);
      for (let i = 1; i < segments.length; i += 1) {
        keptDirs.add(segments.slice(0, i).join("/"));
      }
    }
    for (const file of input.files) {
      if (file.kind !== "delete") continue;
      const segments = safeRelativePath(file.path);
      const target = join(worktree, ...segments);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) {
        throw new TrialAdoptionError("base_changed");
      }
      const baseBytes = readFileSync(target);
      if (file.baseSha256 === null || sha256(baseBytes) !== file.baseSha256) {
        throw new TrialAdoptionError("base_changed");
      }
      rmSync(target);
      // Drop ancestor directories left empty by the verified deletion, but
      // only ancestors of verified paths and never the repository root. A
      // directory still needed by another verified path is kept.
      for (let i = segments.length - 1; i >= 1; i -= 1) {
        const relative = segments.slice(0, i).join("/");
        if (keptDirs.has(relative)) break;
        const dir = join(worktree, ...segments.slice(0, i));
        const dirStat = lstatSync(dir, { throwIfNoEntry: false });
        if (
          dirStat === undefined ||
          dirStat.isSymbolicLink() ||
          !dirStat.isDirectory()
        ) {
          break;
        }
        if (readdirSync(dir).length > 0) break;
        rmdirSync(dir);
      }
    }
    for (const file of input.files) {
      if (file.kind === "delete") continue;
      const segments = safeRelativePath(file.path);
      const target = join(worktree, ...segments);
      prepareParentDirectories(worktree, segments);
      if (file.kind === "create") {
        const existing = lstatSync(target, { throwIfNoEntry: false });
        if (existing !== undefined)
          throw new TrialAdoptionError("base_changed");
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
      if (file.candidateBytes === null) {
        throw new TrialAdoptionError("not_verified");
      }
      const baseMode = statSync(target).mode & 0o777;
      writeFileSync(target, file.candidateBytes);
      // Preserve the base mode exactly; candidates never alter modes.
      chmodSync(target, baseMode);
    }

    let commitSha: string;
    {
      // Stage exactly the verified bytes. `git add` would let clean/smudge/eol
      // filters rewrite content on the way into the index, so write each blob
      // with filters disabled and update the index directly. Ignore rules are
      // bypassed too: an ignored candidate must never be dropped.
      const verifiedPaths = input.files.map((file) => file.path);
      for (const file of input.files) {
        const segments = safeRelativePath(file.path);
        const target = join(worktree, ...segments);
        if (file.kind === "delete") {
          const removed = await git(worktree, [
            "update-index",
            "--remove",
            "--",
            file.path,
          ]);
          if (removed.code !== 0) throw new TrialAdoptionError("git_failed");
          continue;
        }
        const candidateBytes = file.candidateBytes;
        if (candidateBytes === null) {
          throw new TrialAdoptionError("not_verified");
        }
        // Re-read the materialized file: filters must never see a different
        // byte sequence than the one the human reviewed.
        if (sha256(readFileSync(target)) !== sha256(candidateBytes)) {
          throw new TrialAdoptionError("git_failed");
        }
        const baseMode =
          file.kind === "modify" ? statSync(target).mode & 0o777 : 0o644;
        const mode = (baseMode & 0o111) === 0 ? "100644" : "100755";
        const hashed = await git(worktree, [
          "hash-object",
          "-w",
          "--no-filters",
          "--",
          file.path,
        ]);
        const oid = hashed.stdout.trim();
        if (hashed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) {
          throw new TrialAdoptionError("git_failed");
        }
        const updated = await git(worktree, [
          "update-index",
          "--add",
          "--cacheinfo",
          `${mode},${oid},${file.path}`,
        ]);
        if (updated.code !== 0) throw new TrialAdoptionError("git_failed");
        // Prove the index points at the blob we just hashed with filters off.
        const stagedEntry = await git(worktree, [
          "ls-files",
          "--stage",
          "--",
          file.path,
        ]);
        const entry = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t/.exec(
          stagedEntry.stdout,
        );
        if (
          stagedEntry.code !== 0 ||
          entry === null ||
          entry[1] !== mode ||
          entry[2] !== oid
        ) {
          throw new TrialAdoptionError("git_failed");
        }
      }
      // Confirm the staged path set matches exactly (deletes included).
      const staged = await git(worktree, [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
      ]);
      const stagedPaths = staged.stdout
        .split("\0")
        .filter((path) => path.length > 0)
        .sort();
      const expectedPaths = [...verifiedPaths].sort();
      if (
        staged.code !== 0 ||
        stagedPaths.length !== expectedPaths.length ||
        stagedPaths.some((path, index) => path !== expectedPaths[index])
      ) {
        throw new TrialAdoptionError("git_failed");
      }
      const expected = await git(worktree, ["write-tree"]);
      const expectedTree = expected.stdout.trim();
      if (expected.code !== 0 || !/^[0-9a-f]{40,64}$/.test(expectedTree)) {
        throw new TrialAdoptionError("git_failed");
      }
      if (existingRef !== null) {
        // Resume is allowed only when the existing tip is provably the commit
        // this exact execution would have pushed: same trailers, same tree as
        // the rebuilt expected tree, and the base commit as its parent. A
        // rewritten/foreign tip with copied trailers must not pass.
        const log = await git(worktree, [
          "log",
          "-1",
          "--format=%B",
          existingRef,
        ]);
        const message = log.stdout;
        const tip = await git(worktree, [
          "rev-parse",
          "--verify",
          `${existingRef}^{commit}`,
        ]);
        const tipTree = await git(worktree, [
          "rev-parse",
          "--verify",
          `${existingRef}^{tree}`,
        ]);
        const parent = await git(worktree, [
          "rev-parse",
          "--verify",
          `${existingRef}^`,
        ]);
        if (
          log.code !== 0 ||
          !message.includes(`Trial-Execution: ${input.executionId}`) ||
          !message.includes(`Artifact-Sha256: ${input.artifactSha256}`) ||
          tip.code !== 0 ||
          tipTree.code !== 0 ||
          parent.code !== 0 ||
          tipTree.stdout.trim() !== expectedTree ||
          parent.stdout.trim() !== baseCommit
        ) {
          throw new TrialAdoptionError("branch_exists");
        }
        commitSha = tip.stdout.trim();
      } else {
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

        if (!push) {
          // Local-only apply: keep the commit on a branch in the operator
          // checkout. No remote write, no PR, no deploy.
          const head = await git(worktree, ["rev-parse", "--verify", "HEAD"]);
          if (head.code !== 0) throw new TrialAdoptionError("git_failed");
          commitSha = head.stdout.trim();
          const created = await git(config.repoPath, [
            "branch",
            branch,
            commitSha,
          ]);
          if (created.code !== 0) throw new TrialAdoptionError("branch_exists");
          return { branch, prUrl: null, commitSha, baseSha: baseCommit };
        }

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
        const head = await git(worktree, ["rev-parse", "--verify", "HEAD"]);
        if (head.code !== 0) throw new TrialAdoptionError("git_failed");
        commitSha = head.stdout.trim();
      }
    }

    const remoteUrl = await git(config.repoPath, [
      "remote",
      "get-url",
      config.remote,
    ]);
    const repoSlug =
      remoteUrl.code === 0 ? parseGithubRepo(remoteUrl.stdout) : null;
    const title = `trial: ${commitSubject(input.objective)}`;
    const created = await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        baseBranch,
        "--head",
        branch,
        ...(repoSlug === null ? [] : ["--repo", repoSlug]),
        "--title",
        title,
        "--body",
        PR_BODY,
      ],
      worktree,
      GH_TIMEOUT_MS,
      ghEnvironment(),
    );
    if (created.code !== 0) throw new TrialAdoptionError("gh_failed");
    const prUrl = parsePrUrl(created.stdout);
    if (prUrl === null) throw new TrialAdoptionError("gh_failed");
    return { branch, prUrl, commitSha, baseSha: baseCommit };
  } finally {
    if (worktreeAdded) {
      await git(config.repoPath, ["worktree", "remove", "--force", worktree]);
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}
