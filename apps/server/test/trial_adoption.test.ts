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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTrialAdoption, runCommand } from "../src/trial_adoption.js";

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

// These tests spawn POSIX shell scripts (fake gh) and use chmod/symlinks;
// the adoption feature executes on the Linux host only.
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

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
  mkdirSync(join(checkout, "entry"));
  writeFileSync(join(checkout, "entry", "old.txt"), Buffer.from("nested\n"));
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

posixDescribe("executeTrialAdoption", () => {
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
      commitSha: git(remote, "rev-parse", `refs/heads/${branch}`).trim(),
      baseSha: git(checkout, "rev-parse", "HEAD").trim(),
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
      commitSha: pushedBefore.trim(),
      baseSha: git(checkout, "rev-parse", "HEAD").trim(),
    });
    expect(git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(pushedBefore);
  });
  it("treats an identical delete+create pair as two staged paths", async () => {
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/12\n'\n",
      { mode: 0o755 },
    );
    const executionId = "13131313-3535-4646-8676-787878787878";
    const result = await executeTrialAdoption({
      config: config(),
      executionId,
      artifactSha256: ARTIFACT_SHA,
      objective: "rename",
      files: [
        {
          path: DELETE_FILE,
          kind: "delete" as const,
          baseSha256: sha(DELETE_BYTES),
          candidateBytes: null,
        },
        {
          path: "copy.txt",
          kind: "create" as const,
          baseSha256: null,
          candidateBytes: DELETE_BYTES,
        },
      ],
    });
    const branch = `trial/${executionId.slice(0, 8)}`;
    expect(result.branch).toBe(branch);
    // Rename detection must not collapse the pair into one path.
    expect(git(remote, "show", `${branch}:copy.txt`)).toBe("remove me\n");
    expect(() => git(remote, "show", `${branch}:${DELETE_FILE}`)).toThrow();
  });

  it("rejects a rewritten tip that copies the expected trailers", async () => {
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/13\n'\n",
      { mode: 0o755 },
    );
    const executionId = "14141414-3636-4747-8787-898989898989";
    const first = await executeTrialAdoption({
      config: config(),
      executionId,
      artifactSha256: ARTIFACT_SHA,
      objective: "amend target",
      files: files(),
    });
    const branch = first.branch;
    // Rewrite the pushed tip with the same message/trailers but another tree.
    const clone = join(root, "amend-clone");
    execFileSync("git", ["clone", "-q", remote, clone]);
    git(clone, "config", "user.name", "test");
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "checkout", "-q", branch);
    writeFileSync(join(clone, "sneaky.txt"), "sneaky\n");
    git(clone, "add", "sneaky.txt");
    git(clone, "commit", "-q", "--amend", "--no-edit");
    git(remote, "update-ref", "-d", `refs/heads/${branch}`);
    git(clone, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId,
        artifactSha256: ARTIFACT_SHA,
        objective: "amend target",
        files: files(),
      }),
    ).rejects.toMatchObject({ code: "branch_exists" });
    rmSync(clone, { recursive: true, force: true });
  });

  it("resumes against the original base after the base branch advanced", async () => {
    const executionId = "15151515-3737-4848-8888-909090909090";
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    let storedBase: string | null = null;
    await expect(
      executeTrialAdoption({
        config: config(),
        executionId,
        artifactSha256: ARTIFACT_SHA,
        objective: "advance base",
        files: files(),
        onBaseSha: (sha) => {
          storedBase = sha;
        },
      }),
    ).rejects.toMatchObject({ code: "gh_failed" });
    expect(storedBase).toBe(git(checkout, "rev-parse", "origin/master").trim());
    const branch = `trial/${executionId.slice(0, 8)}`;
    const pushed = git(remote, "rev-parse", `refs/heads/${branch}`).trim();
    // The base branch advances after the push; a naive resume would rebuild
    // the expected tree on the new tip and reject its own branch.
    writeFileSync(join(checkout, "later.txt"), "later\n");
    git(checkout, "add", "later.txt");
    git(checkout, "commit", "-m", "later");
    git(checkout, "push", "origin", "master");
    const advanced = git(remote, "rev-parse", "refs/heads/master").trim();
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/14\n'\n",
      { mode: 0o755 },
    );
    const resumed = await executeTrialAdoption({
      config: config(),
      executionId,
      artifactSha256: ARTIFACT_SHA,
      objective: "advance base",
      files: files(),
      baseSha: storedBase,
    });
    expect(resumed).toEqual({
      branch,
      prUrl: "https://github.com/example/repo/pull/14",
      commitSha: pushed,
      baseSha: storedBase,
    });
    // The resumed commit still hangs off the recorded base, not the new tip.
    expect(git(remote, "rev-parse", `${branch}^`).trim()).toBe(storedBase);
    expect(git(remote, "rev-parse", "refs/heads/master").trim()).toBe(advanced);
  });

  it("replaces a deleted directory entry with a file at the same path", async () => {
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\nprintf 'https://github.com/example/repo/pull/15\n'\n",
      { mode: 0o755 },
    );
    const executionId = "16161616-3838-4949-8989-919191919191";
    const result = await executeTrialAdoption({
      config: config(),
      executionId,
      artifactSha256: ARTIFACT_SHA,
      objective: "dir to file",
      files: [
        {
          path: "entry/old.txt",
          kind: "delete" as const,
          baseSha256: sha(Buffer.from("nested\n")),
          candidateBytes: null,
        },
        {
          path: "entry",
          kind: "create" as const,
          baseSha256: null,
          candidateBytes: Buffer.from("now a file\n"),
        },
      ],
    });
    const branch = `trial/${executionId.slice(0, 8)}`;
    expect(result.branch).toBe(branch);
    expect(git(remote, "cat-file", "-t", `${branch}:entry`)).toBe("blob\n");
    expect(git(remote, "show", `${branch}:entry`)).toBe("now a file\n");
    expect(() => git(remote, "show", `${branch}:entry/old.txt`)).toThrow();
  });

  it("forwards gh tokens to gh only, never to git-like commands", async () => {
    const captured = join(root, "gh-env.txt");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s|%s|%s' "$GH_TOKEN" "$GITHUB_TOKEN" "$GH_HOST" > '${captured}'\nprintf 'https://github.com/example/repo/pull/16\n'\n`,
      { mode: 0o755 },
    );
    const dump = join(root, "dump-env.sh");
    writeFileSync(
      dump,
      '#!/bin/sh\nprintf "%s|%s|%s" "$GH_TOKEN" "$GITHUB_TOKEN" "$GH_HOST"\n',
      { mode: 0o755 },
    );
    const saved = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_HOST: process.env.GH_HOST,
    };
    process.env.GH_TOKEN = "gh-token";
    process.env.GITHUB_TOKEN = "github-token";
    process.env.GH_HOST = "ghe.example";
    try {
      await executeTrialAdoption({
        config: config(),
        executionId: "17171717-3939-4040-8080-929292929292",
        artifactSha256: ARTIFACT_SHA,
        objective: "gh env",
        files: [
          {
            path: BASE_FILE,
            kind: "modify" as const,
            baseSha256: sha(BASE_BYTES),
            candidateBytes: CANDIDATE_BYTES,
          },
        ],
      });
      expect(readFileSync(captured, "utf8")).toBe(
        "gh-token|github-token|ghe.example",
      );
      // The git-side bounded runner must not inherit any of them.
      const gitLike = await runCommand(dump, [], root, 5000);
      expect(gitLike.stdout).toBe("||");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("kills a timed-out command's whole process group", async () => {
    const pidFile = join(root, "grandchild.pid");
    const script = join(root, "hang.sh");
    writeFileSync(
      script,
      `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    const result = await runCommand(script, [], root, 300);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).toBeNull();
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });
});
