// Human-only adoption executor tests: real local git, bare "remote", fake gh.
// No network. Verifies fixed commit provenance, base-mode preservation,
// branch push, base_changed/branch_exists failures, and worktree cleanup.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTrialAdoption } from "../src/trial_adoption.js";

const EXECUTION_ID = "12345678-1234-4234-8234-123456789012";
const ARTIFACT_SHA = "a".repeat(64);
const BASE_FILE = "app.txt";
const DELETE_FILE = "old.txt";
const BASE_BYTES = Buffer.from("base\n");
const CANDIDATE_BYTES = Buffer.from("candidate\n");
const DELETE_BYTES = Buffer.from("remove me\n");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

let root: string;
let remote: string;
let checkout: string;
let bin: string;
let originalPath: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "companion-adoption-test-"));
  remote = join(root, "remote.git");
  checkout = join(root, "checkout");
  bin = join(root, "bin");
  mkdirSync(bin);
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", checkout]);
  git(checkout, "config", "user.name", "test");
  git(checkout, "config", "user.email", "test@example.com");
  writeFileSync(join(checkout, BASE_FILE), BASE_BYTES);
  chmodSync(join(checkout, BASE_FILE), 0o755);
  writeFileSync(join(checkout, DELETE_FILE), DELETE_BYTES);
  git(checkout, "add", "-A");
  git(checkout, "commit", "-m", "base");
  git(checkout, "branch", "-M", "master");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "origin", "master");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/7\\n'\n",
    { mode: 0o755 },
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

const config = () => ({
  repoPath: checkout,
  remote: "origin",
  baseRef: "origin/master",
  branchPrefix: "trial/",
});

function files() {
  return [
    {
      path: BASE_FILE,
      kind: "modify" as const,
      baseSha256: sha(BASE_BYTES),
      candidateBytes: CANDIDATE_BYTES,
    },
    {
      path: "new.txt",
      kind: "create" as const,
      baseSha256: null,
      candidateBytes: Buffer.from("new\n"),
    },
    {
      path: DELETE_FILE,
      kind: "delete" as const,
      baseSha256: sha(DELETE_BYTES),
      candidateBytes: null,
    },
  ];
}

describe("executeTrialAdoption", () => {
  it("creates a fixed commit on a pushed trial branch and preserves base modes", async () => {
    const result = await executeTrialAdoption({
      config: config(),
      executionId: EXECUTION_ID,
      artifactSha256: ARTIFACT_SHA,
      objective: "Add the thing\nsecond line",
      files: files(),
    });
    const branch = `trial/${EXECUTION_ID.slice(0, 8)}`;
    expect(result).toEqual({
      branch,
      prUrl: "https://github.com/example/repo/pull/7",
    });
    const remoteRefs = git(remote, "show-ref", `refs/heads/${branch}`);
    expect(remoteRefs).toContain(branch);
    const tree = git(remote, "ls-tree", branch, BASE_FILE, "new.txt");
    // Base executable bit survives; the new file is 0644 (100644).
    expect(tree).toContain(`100755 blob`);
    expect(tree).toContain(`100644 blob`);
    const message = git(remote, "log", "-1", "--format=%B", branch);
    expect(message).toContain(`Trial-Execution: ${EXECUTION_ID}`);
    expect(message).toContain(`Artifact-Sha256: ${ARTIFACT_SHA}`);
    expect(message.split("\n")[0]).toBe("trial: Add the thing");
    expect(git(remote, "show", `${branch}:${BASE_FILE}`)).toBe("candidate\n");
    expect(git(remote, "show", `${branch}:new.txt`)).toBe("new\n");
    expect(() => git(remote, "show", `${branch}:${DELETE_FILE}`)).toThrow();
    // Worktree list is empty again (only the main checkout).
    expect(
      git(checkout, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${checkout}`]);
  });

  it("fails base_changed when base bytes differ and removes the worktree", async () => {
    const before = git(checkout, "worktree", "list", "--porcelain");
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId: "87654321-4321-4321-8321-210987654321",
        artifactSha256: ARTIFACT_SHA,
        objective: "changed",
        files: [
          {
            path: BASE_FILE,
            kind: "modify",
            baseSha256: "b".repeat(64),
            candidateBytes: CANDIDATE_BYTES,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "base_changed" });
    expect(git(checkout, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("refuses a foreign existing branch without pushing again", async () => {
    const executionId = "66666666-4444-4444-8444-444444444444";
    git(checkout, "branch", `trial/${executionId.slice(0, 8)}`);
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId,
        artifactSha256: ARTIFACT_SHA,
        objective: "existing",
        files: files(),
      }),
    ).rejects.toMatchObject({ code: "branch_exists" });
    expect(
      git(checkout, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${checkout}`]);
  });

  it("surfaces gh_failed when gh cannot create the draft PR", async () => {
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId: "abcdef12-3456-4789-8abc-def012345678",
        artifactSha256: ARTIFACT_SHA,
        objective: "gh fail",
        files: files(),
      }),
    ).rejects.toMatchObject({ code: "gh_failed" });
    expect(existsSync(join(root, "nope"))).toBe(false);
    expect(
      git(checkout, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${checkout}`]);
  });

  it("rejects symlinked parent directories instead of writing outside", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    execFileSync("ln", ["-s", outside, join(checkout, "linked")]);
    git(checkout, "add", "-A");
    git(checkout, "commit", "-m", "add symlink");
    git(checkout, "push", "origin", "master");
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId: "99999999-1111-4111-8111-111111111111",
        artifactSha256: ARTIFACT_SHA,
        objective: "escape",
        files: [
          {
            path: "linked/new.txt",
            kind: "create" as const,
            baseSha256: null,
            candidateBytes: Buffer.from("escaped\n"),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "base_changed" });
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    git(checkout, "rm", "--cached", "linked");
    git(checkout, "commit", "-m", "drop symlink");
    git(checkout, "push", "origin", "master");
    execFileSync("rm", ["-f", join(checkout, "linked")]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("commits ignored candidate files instead of dropping them", async () => {
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/8\\n'\n",
      { mode: 0o755 },
    );
    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.txt\n");
    const result = await executeTrialAdoption({
      config: config(),
      executionId: "77777777-2222-4222-8222-222222222222",
      artifactSha256: ARTIFACT_SHA,
      objective: "ignored",
      files: [
        {
          path: "ignored.txt",
          kind: "create" as const,
          baseSha256: null,
          candidateBytes: Buffer.from("kept\n"),
        },
      ],
    });
    const branch = "trial/77777777";
    expect(result.branch).toBe(branch);
    expect(
      git(checkout, "show", `refs/remotes/origin/${branch}:ignored.txt`),
    ).toBe("kept\n");
    writeFileSync(join(checkout, ".git", "info", "exclude"), "");
  });

  it("commits candidate bytes even when a clean filter rewrites content", async () => {
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/11\\n'\n",
      { mode: 0o755 },
    );
    // Worktree-local attributes: every .txt file goes through a clean filter
    // that would rewrite the staged bytes if `git add` were used.
    writeFileSync(
      join(checkout, ".git", "info", "attributes"),
      "*.txt filter=rewrite\n",
    );
    git(checkout, "config", "filter.rewrite.clean", "tr a-z A-Z");
    const probe = join(root, "filter-probe.txt");
    writeFileSync(probe, CANDIDATE_BYTES);
    try {
      const filtered = git(
        checkout,
        "hash-object",
        "--path=app.txt",
        probe,
      ).trim();
      const raw = git(checkout, "hash-object", "--no-filters", probe).trim();
      expect(filtered).not.toBe(raw);
      const executionId = "12121212-3434-4545-8565-676767676767";
      const result = await executeTrialAdoption({
        config: config(),
        executionId,
        artifactSha256: ARTIFACT_SHA,
        objective: "filter proof",
        files: files(),
      });
      const branch = `trial/${executionId.slice(0, 8)}`;
      expect(result.branch).toBe(branch);
      // Bypassing filters means the committed blob is the reviewed byte
      // sequence, not the clean-filter output.
      expect(git(remote, "show", `${branch}:${BASE_FILE}`)).toBe("candidate\n");
      expect(git(remote, "show", `${branch}:new.txt`)).toBe("new\n");
      expect(() => git(remote, "show", `${branch}:${DELETE_FILE}`)).toThrow();
    } finally {
      rmSync(probe, { force: true });
      rmSync(join(checkout, ".git", "info", "attributes"), { force: true });
      try {
        git(checkout, "config", "--unset", "filter.rewrite.clean");
      } catch {
        // Already absent.
      }
    }
  });

  it("resumes PR creation after a successful push without re-pushing", async () => {
    const executionId = "55555555-3333-4333-8333-333333333333";
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId,
        artifactSha256: ARTIFACT_SHA,
        objective: "resume",
        files: files(),
      }),
    ).rejects.toMatchObject({ code: "gh_failed" });
    const branch = `trial/${executionId.slice(0, 8)}`;
    const pushedBefore = git(remote, "rev-parse", `refs/heads/${branch}`);
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/9\\n'\n",
      { mode: 0o755 },
    );
    const resumed = await executeTrialAdoption({
      config: config(),
      executionId,
      artifactSha256: ARTIFACT_SHA,
      objective: "resume",
      files: files(),
    });
    expect(resumed).toEqual({
      branch,
      prUrl: "https://github.com/example/repo/pull/9",
    });
    expect(git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(pushedBefore);
  });
});
