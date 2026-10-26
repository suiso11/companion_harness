// Focused tests for the sealed source snapshot / candidate scope boundary.
// The fixtures are synthetic: no real source, private file, or credential is
// read. Each test builds a temp source root with ignored scaffolding so the
// explicit-manifest behavior is observable.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CandidateValidationResult,
  SealedWorkspaceSnapshot,
} from "../src/autonomous_workspace.js";
import {
  createSealedWorkspaceSnapshot,
  SealedWorkspaceError,
  validateCandidateChanges,
  verifySealedWorkspaceSnapshot,
} from "../src/autonomous_workspace.js";

const posixDescribe = process.platform === "win32" ? describe.skip : describe;

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sealed-${label}-`));
  roots.push(dir);
  return dir;
}

function write(path: string, content: string, mode?: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, mode === undefined ? {} : { mode });
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface Fixture {
  readonly source: string;
  readonly snapshot: SealedWorkspaceSnapshot;
}

async function makeFixture(options?: {
  readonly source?: string;
  readonly maxArtifactBytes?: number;
  readonly maxBytes?: number;
}): Promise<Fixture> {
  const source = options?.source ?? tempRoot("source");
  write(join(source, "src/app.ts"), "export const app = 'dirty-v1';\n");
  write(join(source, "src/util.ts"), "export const util = 1;\n");
  write(join(source, "src/.env"), "TOP_SECRET=do-not-copy\n");
  write(join(source, "src/run.log"), "private log\n");
  write(
    join(source, "src/node_modules/dep/index.js"),
    "module.exports = 'dependency';\n",
  );
  write(
    join(source, "src/nested/.wt-work/evil.ts"),
    "export const evil = true;\n",
  );
  write(join(source, "src/.git/config"), "[core]\n");
  write(join(source, "docs/readme.md"), "# docs\n");
  write(join(source, "package.json"), '{"name":"fixture"}\n');
  write(join(source, ".npmrc"), "//registry.example/:_authToken=secret\n");
  const output = join(tempRoot("output"), "workspace");
  const snapshot = await createSealedWorkspaceSnapshot({
    sourceRoot: source,
    outputDir: output,
    allowedRoots: ["src", "docs"],
    allowedTopLevelFiles: ["package.json"],
    ...(options?.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: options.maxArtifactBytes }),
    ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { source, snapshot };
}

async function copyCandidate(
  snapshot: SealedWorkspaceSnapshot,
): Promise<string> {
  const candidate = join(tempRoot("candidate"), "work");
  cpSync(snapshot.snapshotRoot, candidate, { recursive: true });
  return candidate;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "SealedWorkspaceError",
    code,
  });
}

function rejected(result: CandidateValidationResult): string[] {
  if (result.ok) {
    throw new Error("expected rejection");
  }
  return [...result.rejected];
}

posixDescribe("createSealedWorkspaceSnapshot", () => {
  it("copies only explicit allowed paths and includes dirty bytes", async () => {
    const { snapshot } = await makeFixture();
    expect(snapshot.manifest.map((entry) => entry.path)).toEqual([
      "docs/readme.md",
      "package.json",
      "src/app.ts",
      "src/util.ts",
    ]);
    expect(snapshot.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.sourceIdentity.identityKind).toBe("content-manifest");
    expect(snapshot.sourceIdentity.includesUncommittedBytes).toBe(true);
    expect(snapshot.sourceIdentity.fileCount).toBe(4);
    expect(
      snapshot.manifest.find((entry) => entry.path === "src/app.ts")?.sha256,
    ).toBe(sha256("export const app = 'dirty-v1';\n"));
    expect(
      readFileSync(join(snapshot.snapshotRoot, "src/app.ts"), "utf8"),
    ).toBe("export const app = 'dirty-v1';\n");
    // Ignored scaffolding and secrets are absent from the snapshot.
    expect(() =>
      readFileSync(join(snapshot.snapshotRoot, "src/.env")),
    ).toThrow();
    expect(() =>
      readFileSync(
        join(snapshot.snapshotRoot, "src/node_modules/dep/index.js"),
      ),
    ).toThrow();
    expect(() =>
      readFileSync(join(snapshot.snapshotRoot, "src/nested/.wt-work/evil.ts")),
    ).toThrow();
    const verified = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: snapshot.manifestDigest,
    });
    expect(verified.ok).toBe(true);
  });

  it("keeps the snapshot immutable when the source changes later", async () => {
    const { source, snapshot } = await makeFixture();
    appendFileSync(join(source, "src/app.ts"), "// later edit\n");
    const verified = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: snapshot.manifestDigest,
    });
    expect(verified.ok).toBe(true);
    expect(
      readFileSync(join(snapshot.snapshotRoot, "src/app.ts"), "utf8"),
    ).toBe("export const app = 'dirty-v1';\n");
  });

  it("rejects source symlinks, including internal-looking ones", async () => {
    const source = tempRoot("symlink-source");
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    symlinkSync("app.ts", join(source, "src/link.ts"));
    const output = join(tempRoot("output"), "workspace");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: output,
        allowedRoots: ["src"],
        allowedTopLevelFiles: [],
      }),
      "symlink_rejected",
    );
  });

  it("copies a literal nested file root alone and excludes siblings", async () => {
    const source = tempRoot("literal-file-source");
    write(join(source, "package.json"), '{"name":"literal"}\n');
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    write(join(source, "src/nested/deep.ts"), "export const deep = 2;\n");
    write(join(source, "src/nested/sibling.ts"), "export const sibling = 3;\n");
    const snapshot = await createSealedWorkspaceSnapshot({
      sourceRoot: source,
      outputDir: join(tempRoot("output"), "workspace"),
      allowedRoots: ["src/nested/deep.ts"],
      allowedTopLevelFiles: ["package.json"],
    });
    expect(snapshot.manifest.map((entry) => entry.path)).toEqual([
      "package.json",
      "src/nested/deep.ts",
    ]);
    expect(snapshot.sourceIdentity.fileCount).toBe(2);
    expect(
      readFileSync(join(snapshot.snapshotRoot, "src/nested/deep.ts"), "utf8"),
    ).toBe("export const deep = 2;\n");
    expect(() =>
      readFileSync(join(snapshot.snapshotRoot, "src/app.ts")),
    ).toThrow();
    expect(() =>
      readFileSync(join(snapshot.snapshotRoot, "src/nested/sibling.ts")),
    ).toThrow();

    // A literal file scope is an exact allowedEditPaths entry: the scoped
    // file may change, while a sibling remains a scope violation.
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "src/nested/deep.ts"), "export const deep = 4;\n");
    const accepted = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src/nested/deep.ts"],
    });
    expect(accepted.ok).toBe(true);

    const siblingCandidate = await copyCandidate(snapshot);
    write(join(siblingCandidate, "src/nested/sibling.ts"), "extra\n");
    const siblingResult = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: siblingCandidate,
      mode: "write",
      allowedEditPaths: ["src/nested/deep.ts"],
    });
    expect(rejected(siblingResult).join("\n")).toContain("scope_violation");
  });

  it("rejects symlinked parents and files in a literal file root", async () => {
    const source = tempRoot("literal-file-symlink-source");
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    symlinkSync("app.ts", join(source, "src/link.ts"));
    symlinkSync("src", join(source, "alias"));
    const output = join(tempRoot("output"), "workspace");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: output,
        allowedRoots: ["src/link.ts"],
        allowedTopLevelFiles: [],
      }),
      "symlink_rejected",
    );
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: join(tempRoot("output"), "workspace"),
        allowedRoots: ["alias/app.ts"],
        allowedTopLevelFiles: [],
      }),
      "symlink_rejected",
    );
  });

  it("rejects a denied file in a literal file root", async () => {
    const source = tempRoot("literal-file-denied-source");
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    write(join(source, "src/.env"), "TOP_SECRET=do-not-copy\n");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: join(tempRoot("output"), "workspace"),
        allowedRoots: ["src/.env"],
        allowedTopLevelFiles: [],
      }),
      "forbidden_path",
    );
  });

  it("rejects an output directory inside an allowed subtree", async () => {
    const source = tempRoot("overlap-source");
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    const output = join(source, "src/out");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: output,
        allowedRoots: ["src"],
        allowedTopLevelFiles: [],
      }),
      "output_overlap",
    );
  });

  it("enforces the source byte cap before reading files", async () => {
    const source = tempRoot("bounded-source");
    write(join(source, "src/a.ts"), "0123456789\n");
    write(join(source, "src/b.ts"), "0123456789\n");
    const output = join(tempRoot("output"), "workspace");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: output,
        allowedRoots: ["src"],
        allowedTopLevelFiles: [],
        maxBytes: 10,
      }),
      "byte_budget_exceeded",
    );
  });
});

posixDescribe("verifySealedWorkspaceSnapshot", () => {
  it("detects snapshot content tampering", async () => {
    const { snapshot } = await makeFixture();
    appendFileSync(join(snapshot.snapshotRoot, "src/app.ts"), "tamper\n");
    const verified = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: snapshot.manifestDigest,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toContain("src/app.ts");
    }
  });

  it("detects manifest tampering", async () => {
    const { snapshot } = await makeFixture();
    const manifest = JSON.parse(
      readFileSync(snapshot.manifestPath, "utf8"),
    ) as { entries: { sha256: string }[] };
    const first = manifest.entries[0];
    if (first === undefined) {
      throw new Error("fixture manifest is empty");
    }
    first.sha256 = "0".repeat(64);
    writeFileSync(snapshot.manifestPath, `${JSON.stringify(manifest)}\n`);
    const verified = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: snapshot.manifestDigest,
    });
    expect(verified.ok).toBe(false);
  });

  it("requires the host-pinned digest and a supported snapshot schema", async () => {
    const { snapshot } = await makeFixture();
    const wrongDigest = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: "0".repeat(64),
    });
    expect(wrongDigest.ok).toBe(false);
    if (!wrongDigest.ok) {
      expect(wrongDigest.reason).toContain("host-pinned");
    }

    // A consistent deserialized object is not stale; the digest is supplied
    // by the host, so a round-tripped snapshot still verifies.
    const deserialized = JSON.parse(
      JSON.stringify(snapshot),
    ) as SealedWorkspaceSnapshot;
    await expect(
      verifySealedWorkspaceSnapshot(deserialized, {
        expectedManifestDigest: snapshot.manifestDigest,
      }),
    ).resolves.toMatchObject({ ok: true });

    const wrongSchema = {
      ...deserialized,
      schemaVersion: 2,
    } as unknown as SealedWorkspaceSnapshot;
    const schemaResult = await verifySealedWorkspaceSnapshot(wrongSchema, {
      expectedManifestDigest: snapshot.manifestDigest,
    });
    expect(schemaResult.ok).toBe(false);
  });
});

posixDescribe("validateCandidateChanges", () => {
  it("returns verified add/modify/delete metadata with base hashes", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "src/app.ts"), "export const app = 'v2';\n");
    write(join(candidate, "src/new.ts"), "export const added = true;\n");
    rmSync(join(candidate, "src/util.ts"));
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.artifact.changeCount).toBe(3);
    expect(
      result.artifact.changes.map((change) => [change.path, change.kind]),
    ).toEqual([
      ["src/app.ts", "modify"],
      ["src/new.ts", "add"],
      ["src/util.ts", "delete"],
    ]);
    const modified = result.artifact.changes.find(
      (change) => change.path === "src/app.ts",
    );
    expect(modified?.baseSha256).toBe(
      sha256("export const app = 'dirty-v1';\n"),
    );
    expect(modified?.baseSha256).not.toBe(modified?.candidateSha256);
    expect(JSON.stringify(result.artifact)).not.toContain("dirty-v1");
  });

  it("rejects any read-only delivered change", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "src/app.ts"), "changed\n");
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "read_only",
      allowedEditPaths: ["src"],
    });
    expect(rejected(result).join("\n")).toContain("read_only_violation");
  });

  it("allows a clean read-only candidate", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "read_only",
      allowedEditPaths: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.changeCount).toBe(0);
    }
  });

  it("rejects changes outside the frozen edit scope", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "package.json"), '{"name":"changed"}\n');
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(rejected(result).join("\n")).toContain("package.json");
    expect(rejected(result).join("\n")).toContain("scope_violation");
  });

  it("excludes declared scratch roots from the deliverable", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "build/out.js"), "generated\n");
    write(join(candidate, "dist/out.js"), "generated\n");
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
      generatedScratchRoots: ["build", "dist"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.changeCount).toBe(0);
    }
  });

  it("refuses a scratch root that would hide an allowed edit path", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    await expectCode(
      validateCandidateChanges({
        snapshot,
        expectedManifestDigest: snapshot.manifestDigest,
        candidateRoot: candidate,
        mode: "write",
        allowedEditPaths: ["src/app.ts"],
        generatedScratchRoots: ["src"],
      }),
      "invalid_input",
    );
  });

  it("rejects a scratch root that hides a tracked sealed source change", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "src/util.ts"), "export const util = 2;\n");
    await expectCode(
      validateCandidateChanges({
        snapshot,
        expectedManifestDigest: snapshot.manifestDigest,
        candidateRoot: candidate,
        mode: "write",
        allowedEditPaths: ["src"],
        generatedScratchRoots: ["src/util.ts"],
      }),
      "invalid_input",
    );
  });

  it("rejects setid/sticky source and candidate modes", async () => {
    const source = tempRoot("unsafe-mode-source");
    write(join(source, "src/app.ts"), "export const app = 1;\n");
    chmodSync(join(source, "src/app.ts"), 0o4755);
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: source,
        outputDir: join(tempRoot("output"), "workspace"),
        allowedRoots: ["src"],
        allowedTopLevelFiles: [],
      }),
      "nonregular_rejected",
    );

    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    chmodSync(join(candidate, "src/app.ts"), 0o2755);
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(rejected(result).join("\n")).toContain("setuid/setgid/sticky");
  });

  it("rejects a candidate nested in the original source root", async () => {
    const { source, snapshot } = await makeFixture();
    const candidate = join(source, "src/candidate");
    cpSync(snapshot.snapshotRoot, candidate, { recursive: true });
    await expectCode(
      validateCandidateChanges({
        snapshot,
        expectedManifestDigest: snapshot.manifestDigest,
        candidateRoot: candidate,
        mode: "write",
        allowedEditPaths: ["src"],
      }),
      "invalid_input",
    );
  });

  it("rejects candidate symlinks and forbidden secret paths", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    symlinkSync("app.ts", join(candidate, "src/link.ts"));
    const symlinkResult = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(rejected(symlinkResult).join("\n")).toContain("symlink_rejected");
    rmSync(join(candidate, "src/link.ts"));
    write(join(candidate, "src/.env"), "TOKEN=secret\n");
    const secretResult = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(rejected(secretResult).join("\n")).toContain("forbidden_path");
  });

  it("rejects case-ambiguous candidate paths where the fs is ambiguous", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(candidate, "src/App.ts"), "export const upper = true;\n");
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
      caseInsensitiveFs: true,
    });
    expect(rejected(result).join("\n")).toContain("case_ambiguous");

    const directoryCandidate = await copyCandidate(snapshot);
    write(join(directoryCandidate, "src/Foo/a.ts"), "export const a = 1;\n");
    write(join(directoryCandidate, "src/foo/b.ts"), "export const b = 1;\n");
    const directoryResult = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: directoryCandidate,
      mode: "write",
      allowedEditPaths: ["src"],
      caseInsensitiveFs: true,
    });
    expect(rejected(directoryResult).join("\n")).toContain("case_ambiguous");
  });

  it("rejects unsafe scope paths and oversized artifacts", async () => {
    const { snapshot } = await makeFixture({ maxArtifactBytes: 200 });
    const candidate = await copyCandidate(snapshot);
    await expectCode(
      validateCandidateChanges({
        snapshot,
        expectedManifestDigest: snapshot.manifestDigest,
        candidateRoot: candidate,
        mode: "write",
        allowedEditPaths: ["../escape"],
      }),
      "invalid_input",
    );
    write(join(candidate, "src/app.ts"), "export const app = 'longer';\n");
    const result = await validateCandidateChanges({
      snapshot,
      expectedManifestDigest: snapshot.manifestDigest,
      candidateRoot: candidate,
      mode: "write",
      allowedEditPaths: ["src"],
    });
    expect(rejected(result).join("\n")).toContain("artifact_budget_exceeded");
  });

  it("fails closed when the snapshot is tampered before validation", async () => {
    const { snapshot } = await makeFixture();
    const candidate = await copyCandidate(snapshot);
    write(join(snapshot.snapshotRoot, "src/util.ts"), "tampered\n");
    await expectCode(
      validateCandidateChanges({
        snapshot,
        expectedManifestDigest: snapshot.manifestDigest,
        candidateRoot: candidate,
        mode: "write",
        allowedEditPaths: ["src"],
      }),
      "snapshot_tampered",
    );
  });
});

describe("SealedWorkspaceError", () => {
  it("carries a typed violation code", () => {
    const error = new SealedWorkspaceError("scope_violation", "outside");
    expect(error.code).toBe("scope_violation");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("unsupported host contract", () => {
  it("fails closed before creating any output or reading a snapshot", async () => {
    const root = tempRoot("unsupported");
    const output = join(root, "workspace");
    await expectCode(
      createSealedWorkspaceSnapshot({
        sourceRoot: join(root, "does-not-exist"),
        outputDir: output,
        allowedRoots: [],
        allowedTopLevelFiles: [],
        platform: "win32",
      }),
      "unsupported_platform",
    );
    // The rejection is BEFORE mkdir/copy, so no consumer output exists.
    expect(existsSync(output)).toBe(false);

    const verified = await verifySealedWorkspaceSnapshot(
      {} as SealedWorkspaceSnapshot,
      { expectedManifestDigest: "not-a-digest", platform: "win32" },
    );
    expect(verified).toMatchObject({ ok: false });
    if (verified.ok) throw new Error("expected unsupported rejection");
    expect(verified.reason).toContain("unsupported_platform");

    await expectCode(
      validateCandidateChanges({
        snapshot: {} as SealedWorkspaceSnapshot,
        expectedManifestDigest: "not-a-digest",
        candidateRoot: join(root, "does-not-exist"),
        mode: "read_only",
        allowedEditPaths: [],
        platform: "win32",
      }),
      "unsupported_platform",
    );
  });
});
