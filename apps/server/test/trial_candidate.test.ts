import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrialConfig } from "../src/config.js";
import {
  loadTrialCandidate,
  TrialCandidateError,
  truncateDiff,
} from "../src/trial_candidate.js";

const EXECUTION_ID = "6747773a-0000-4000-8000-000000000000";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    readonly extraDeletes?: number;
  } = {},
): Fixture {
  const path = options.path ?? "apps/a.ts";
  const kind = options.kind ?? "modify";
  const base = options.base ?? "one\n";
  const candidate = options.candidate ?? "two\n";
  const root = mkdtempSync(join(tmpdir(), "companion-candidate-"));
  // The frozen source snapshot: a plain tree, no .git. The trial's revision is
  // the synthetic manifest hash, so base bytes can only come from here.
  const repo = join(root, "source");
  mkdirSync(join(repo, "apps"), { recursive: true });
  writeFileSync(join(repo, "apps/a.ts"), base);
  const revision = "a".repeat(40);
  const stateDir = join(root, "state");
  const runDir = join(stateDir, "runs", EXECUTION_ID);
  const candidateRoot = join(runDir, "candidate");
  mkdirSync(join(candidateRoot, "apps"), { recursive: true });
  if (kind !== "delete") {
    mkdirSync(dirname(join(candidateRoot, path)), { recursive: true });
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
  const changes =
    options.extraDeletes === undefined
      ? [change]
      : Array.from({ length: options.extraDeletes }, (_, i) => {
          const deletePath = `apps/d${i}.bin`;
          const bytes = Buffer.from(`\0${i}`);
          writeFileSync(join(repo, deletePath), bytes);
          return {
            path: deletePath,
            kind: "delete" as const,
            baseSha256: sha256(bytes),
            baseMode: 0o100644,
            candidateSha256: null,
            candidateMode: null,
            size: 0,
          };
        });
  const artifactBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      executionId: EXECUTION_ID,
      taskHash: "f".repeat(64),
      baseManifestDigest: "d".repeat(64),
      profileFingerprint: "e".repeat(64),
      sourceRevision: revision,
      changeCount: changes.length,
      changes,
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

  it("validates against the grant's frozen allowedPaths, not the current template", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    // The template drifted to `packages` after approval; the grant froze
    // `apps`, so the retained apps/ change must still be accepted.
    const driftedTrial = {
      ...fixture.trial,
      allowedPaths: ["packages"],
    };
    const view = loadTrialCandidate({
      executionId: fixture.executionId,
      trial: driftedTrial,
      expectedArtifactSha256: fixture.artifactSha256,
      literalPatchPaths: ["apps/a.ts"],
      frozenAllowedPaths: ["apps"],
    });
    expect(view.changes[0]?.path).toBe("apps/a.ts");
    // And a frozen scope that does not cover the change still fails closed.
    expect(() =>
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: fixture.trial,
        expectedArtifactSha256: fixture.artifactSha256,
        literalPatchPaths: ["apps/a.ts"],
        frozenAllowedPaths: ["packages"],
      }),
    ).toThrow(/candidate_unavailable/);
  });

  it("falls back to the current template scope for legacy grants", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    const narrowTrial = { ...fixture.trial, allowedPaths: ["packages"] };
    expect(() =>
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: narrowTrial,
        expectedArtifactSha256: fixture.artifactSha256,
        literalPatchPaths: ["apps/a.ts"],
      }),
    ).toThrow(/candidate_unavailable/);
    expect(
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: fixture.trial,
        expectedArtifactSha256: fixture.artifactSha256,
        literalPatchPaths: ["apps/a.ts"],
      }).changes[0]?.path,
    ).toBe("apps/a.ts");
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

  it("reviews a deletion-only artifact with no retained candidate tree", () => {
    const fixture = makeFixture({ kind: "delete" });
    roots.push(fixture.root);
    rmSync(join(fixture.root, "state", "runs", EXECUTION_ID, "candidate"), {
      recursive: true,
      force: true,
    });
    const view = load(fixture);
    expect(view.changes[0]?.kind).toBe("delete");
    expect(view.diff).toContain("-one");
  });

  it("truncates diffs larger than the old spawn buffer", () => {
    // ~600 KiB of unified diff output: more than the previous 256 KiB
    // maxBuffer, which made a valid large change fail as unavailable.
    const fixture = makeFixture({
      base: "x\n".repeat(150_000),
      candidate: "y\n".repeat(150_000),
    });
    roots.push(fixture.root);
    const view = load(fixture);
    expect(view.truncated).toBe(true);
    expect(Buffer.byteLength(view.diff, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("truncates by UTF-8 bytes, not UTF-16 length", () => {
    const fixture = makeFixture({ candidate: `${"あ".repeat(30_000)}\n` });
    roots.push(fixture.root);
    const view = load(fixture);
    expect(view.truncated).toBe(true);
    // The marker is inside the 65536-byte budget (off-by-one guard).
    expect(Buffer.byteLength(view.diff, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(view.diff.endsWith("\n… (truncated)\n")).toBe(true);
  });

  it("keeps the truncation marker within an exact 65536-byte budget", () => {
    // A single ASCII line yields a header plus one huge hunk line: the cut
    // lands exactly at the cap and must still leave room for the marker.
    const fixture = makeFixture({ candidate: `${"z".repeat(140_000)}\n` });
    roots.push(fixture.root);
    const view = load(fixture);
    expect(view.truncated).toBe(true);
    expect(Buffer.byteLength(view.diff, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(view.diff.endsWith("\n… (truncated)\n")).toBe(true);
  });

  it("counts the remaining budget against binary notices", () => {
    const notice = "Binary files a/apps/a.ts and b/apps/a.ts differ\n";
    const rendered = truncateDiff(notice, 12);
    expect(rendered.truncated).toBe(true);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(12);
  });

  it("accepts producer-supported nested paths beyond the scope length", () => {
    const segments = Array.from({ length: 40 }, (_, i) =>
      `d${i}`.padEnd(12, "x"),
    );
    const path = `apps/${segments.join("/")}/a.ts`;
    expect(path.length).toBeGreaterThan(512);
    const fixture = makeFixture({ path });
    roots.push(fixture.root);
    const baseDir = join(fixture.repoPath, "apps", ...segments);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, "a.ts"), "one\n");
    const view = load(fixture, [path]);
    expect(view.changes[0]?.path).toBe(path);
    expect(view.truncated).toBe(false);
  });

  it("renders replacement-token filenames literally", () => {
    const path = "apps/$&.ts";
    const fixture = makeFixture({ path });
    roots.push(fixture.root);
    writeFileSync(join(fixture.repoPath, "apps/$&.ts"), "one\n");
    const view = load(fixture, ["apps/$&.ts"]);
    expect(view.diff).toContain("--- a/apps/$&.ts");
    expect(view.diff).toContain("+++ b/apps/$&.ts");
    expect(view.diff).not.toContain("a/apps/---");
  });

  it("fails closed when the frozen snapshot base file is missing", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    rmSync(join(fixture.repoPath, "apps/a.ts"));
    expect(() => load(fixture)).toThrow(/base_mismatch/);
  });

  it("verifies deletion bases against the sealed source budget, not 16 MiB", () => {
    const base = "a".repeat(17 * 1024 * 1024);
    const fixture = makeFixture({ kind: "delete", base });
    roots.push(fixture.root);
    const view = load(fixture);
    expect(view.changes[0]?.kind).toBe("delete");
    expect(view.truncated).toBe(true);
  });

  it("uses the frozen claim-time roots instead of the current template", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    // Point the current template at a different (pruned) state dir: the
    // frozen roots must win.
    writeFileSync(
      fixture.trial.runner.bridgeConfigTemplatePath,
      JSON.stringify({ stateDir: join(fixture.root, "elsewhere") }),
    );
    const view = loadTrialCandidate({
      executionId: fixture.executionId,
      trial: fixture.trial,
      expectedArtifactSha256: fixture.artifactSha256,
      literalPatchPaths: ["apps/a.ts"],
      frozenStateDir: join(fixture.root, "state"),
      frozenSourceRepoPath: fixture.repoPath,
    });
    expect(view.diff).toContain("-one");
  });

  it("fails closed when a frozen claim-time root was pruned", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    expect(() =>
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: fixture.trial,
        expectedArtifactSha256: fixture.artifactSha256,
        literalPatchPaths: ["apps/a.ts"],
        frozenStateDir: join(fixture.root, "pruned-state"),
        frozenSourceRepoPath: fixture.repoPath,
      }),
    ).toThrow(/candidate_unavailable/);
  });

  it("uses the frozen claim-time source revision when the current config drifts", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    const drifted = { ...fixture.trial, sourceRevision: "b".repeat(40) };
    const loadDrifted = (frozenSourceRevision?: string) =>
      loadTrialCandidate({
        executionId: fixture.executionId,
        trial: drifted,
        expectedArtifactSha256: fixture.artifactSha256,
        literalPatchPaths: ["apps/a.ts"],
        ...(frozenSourceRevision !== undefined ? { frozenSourceRevision } : {}),
      });
    expect(() => loadDrifted()).toThrow(/candidate_unavailable/);
    expect(loadDrifted("a".repeat(40)).diff).toContain("-one");
  });

  it("accepts change counts supported by the bridge", () => {
    const fixture = makeFixture({ extraDeletes: 1001 });
    roots.push(fixture.root);
    const view = loadTrialCandidate({
      executionId: fixture.executionId,
      trial: fixture.trial,
      expectedArtifactSha256: fixture.artifactSha256,
      literalPatchPaths: ["apps"],
    });
    expect(view.changes).toHaveLength(1001);
  });

  it("reviewes create-only candidates after the snapshot is cleaned", () => {
    const fixture = makeFixture({ kind: "create", candidate: "new\n" });
    roots.push(fixture.root);
    // Policy trials delete the heavy sealed snapshot at quiescence.
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const view = load(fixture);
    expect(view.changes[0]?.kind).toBe("create");
    expect(view.diff).toContain("+new");
  });

  it("uses retained base bytes after the snapshot is cleaned", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    const baseDir = join(
      fixture.root,
      "state",
      "runs",
      EXECUTION_ID,
      "base",
      "apps",
    );
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, "a.ts"), "one\n");
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const view = load(fixture);
    expect(view.diff).toContain("-one");
  });

  it("reads base bytes from the snapshot even when a git export is absent", () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    expect(existsSync(join(fixture.repoPath, ".git"))).toBe(false);
    expect(load(fixture).diff).toContain("-one");
  });
});
