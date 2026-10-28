import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrialConfig } from "../src/config.js";
import {
  loadTrialCandidate,
  TrialCandidateError,
} from "../src/trial_candidate.js";

const EXECUTION_ID = "6747773a-0000-4000-8000-000000000000";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

interface Fixture {
  readonly root: string;
  readonly trial: TrialConfig;
  readonly executionId: string;
  readonly artifactSha256: string;
  readonly candidatePath: string;
  readonly repoPath: string;
}

function makeFixture(
  options: {
    readonly base?: string;
    readonly candidate?: string;
    readonly path?: string;
    readonly kind?: "modify" | "create" | "delete";
    readonly baseSha256?: string;
    readonly candidateSha256?: string;
  } = {},
): Fixture {
  const path = options.path ?? "apps/a.ts";
  const kind = options.kind ?? "modify";
  const base = options.base ?? "one\n";
  const candidate = options.candidate ?? "two\n";
  const root = mkdtempSync(join(tmpdir(), "companion-candidate-"));
  const repo = join(root, "source");
  mkdirSync(join(repo, "apps"), { recursive: true });
  git(root, ["init", "-q", "source"]);
  writeFileSync(join(repo, "apps/a.ts"), base);
  git(repo, ["add", "-A"]);
  git(repo, [
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  const revision = git(repo, ["rev-parse", "HEAD"]);
  const stateDir = join(root, "state");
  const runDir = join(stateDir, "runs", EXECUTION_ID);
  const candidateRoot = join(runDir, "candidate");
  mkdirSync(join(candidateRoot, "apps"), { recursive: true });
  if (kind !== "delete") {
    writeFileSync(join(candidateRoot, path), candidate);
  }
  const change = {
    path,
    kind,
    baseSha256: kind === "create" ? null : (options.baseSha256 ?? sha256(base)),
    baseMode: kind === "create" ? null : 0o100644,
    candidateSha256:
      kind === "delete" ? null : (options.candidateSha256 ?? sha256(candidate)),
    candidateMode: kind === "delete" ? null : 0o100644,
    size: kind === "delete" ? 0 : Buffer.byteLength(candidate),
  };
  const artifactBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      executionId: EXECUTION_ID,
      taskHash: "f".repeat(64),
      baseManifestDigest: "d".repeat(64),
      profileFingerprint: "e".repeat(64),
      sourceRevision: revision,
      changeCount: 1,
      changes: [change],
    })}\n`,
  );
  writeFileSync(join(runDir, "artifact.json"), artifactBytes);
  const operatorPath = join(root, "operator.json");
  writeFileSync(operatorPath, JSON.stringify({ stateDir }), { mode: 0o600 });
  const trial = {
    sourceRevision: revision,
    sourceRepoPath: repo,
    allowedPaths: ["apps", "packages"],
    runner: { bridgeConfigTemplatePath: operatorPath },
  } as unknown as TrialConfig;
  return {
    root,
    trial,
    executionId: EXECUTION_ID,
    artifactSha256: sha256(artifactBytes),
    candidatePath: join(candidateRoot, path),
    repoPath: repo,
  };
}

function load(fixture: Fixture, literalPatchPaths: string[] = ["apps/a.ts"]) {
  return loadTrialCandidate({
    executionId: fixture.executionId,
    trial: fixture.trial,
    expectedArtifactSha256: fixture.artifactSha256,
    literalPatchPaths,
  });
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadTrialCandidate", () => {
  it("verifies a retained modify and renders a bounded unified diff", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    const view = load(fixture);
    expect(view.changes).toEqual([
      {
        path: "apps/a.ts",
        kind: "modify",
        size: 4,
        modeChanged: false,
      },
    ]);
    expect(view.diff).toContain("--- a/apps/a.ts");
    expect(view.diff).toContain("+++ b/apps/a.ts");
    expect(view.diff).toContain("-one");
    expect(view.diff).toContain("+two");
    expect(view.truncated).toBe(false);
  });

  it("rejects candidate bytes that no longer match the digest", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    writeFileSync(fixture.candidatePath, "tampered\n");
    expect(() => load(fixture)).toThrow(TrialCandidateError);
    try {
      load(fixture);
    } catch (error) {
      expect((error as TrialCandidateError).code).toBe(
        "candidate_digest_mismatch",
      );
    }
  });

  it("rejects a mutated artifact digest", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    expect(() =>
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: fixture.trial,
        expectedArtifactSha256: "0".repeat(64),
        literalPatchPaths: ["apps/a.ts"],
      }),
    ).toThrow(/candidate_digest_mismatch/);
  });

  it("rejects a symlinked candidate file", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    const outside = join(fixture.root, "outside.ts");
    writeFileSync(outside, "two\n");
    rmSync(fixture.candidatePath);
    symlinkSync(outside, fixture.candidatePath);
    expect(() => load(fixture)).toThrow(/candidate_unavailable/);
  });

  it("rejects a path outside the grant scopes", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    expect(() => load(fixture, ["packages/other.ts"])).toThrow(
      /candidate_unavailable/,
    );
  });

  it("fails closed when the pruned run root is missing", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    rmSync(join(fixture.root, "state"), { recursive: true, force: true });
    expect(() => load(fixture)).toThrow(/candidate_unavailable/);
  });

  it("rejects base bytes that differ from the artifact", () => {
    const fixture = makeFixture({ baseSha256: "1".repeat(64) });
    roots.push(fixture.root);
    expect(() => load(fixture)).toThrow(/base_mismatch/);
  });
});
