import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { describe, expect, it } from "vitest";
import {
  discoverMarkdownFiles,
  discoverMarkdownFilesForRoot,
  enforceVaultFileLimit,
  MAX_FILES_PER_VAULT,
} from "../src/discovery.js";
import { MarkdownConnectorError } from "../src/errors.js";
import { type InitializedRoot, initializeRoots } from "../src/roots.js";

function scratchVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function onlyRoot(roots: InitializedRoot[]): InitializedRoot {
  const first = roots[0];
  if (first === undefined) {
    throw new Error("test setup failed: no root");
  }
  return first;
}

/**
 * Attempt a symlink; report `"privilege-denied"` only when the OS genuinely
 * refuses creation (EPERM/EACCES/EROFS/UNKNOWN). Any other failure is a real
 * error and propagates.
 */
function trySymlink(
  target: string,
  linkPath: string,
  type: "dir" | "file" | "junction",
): "ok" | "privilege-denied" {
  try {
    symlinkSync(target, linkPath, type);
    return "ok";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "EPERM" ||
      code === "EACCES" ||
      code === "EROFS" ||
      code === "UNKNOWN"
    ) {
      return "privilege-denied";
    }
    throw error;
  }
}

function skipUnlessPrivileged(
  ctx: TestContext,
  outcome: "ok" | "privilege-denied",
): boolean {
  if (outcome === "privilege-denied") {
    ctx.skip();
    return false;
  }
  return true;
}

describe("discovery", () => {
  it("discovers unique .md files in code-unit order", async () => {
    const dir = scratchVault("md-disc-order-");
    writeFileSync(join(dir, "b.md"), "# b\n");
    writeFileSync(join(dir, "Z.md"), "# Z\n");
    writeFileSync(join(dir, "a.md"), "# a\n");
    writeFileSync(join(dir, "UPPER.MD"), "# case-sensitive\n");
    writeFileSync(join(dir, "note.txt"), "ignored\n");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "c.md"), "# c\n");
    mkdirSync(join(dir, "weird.md"), { recursive: true });
    writeFileSync(join(dir, "weird.md", "inner.md"), "# inner\n");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const found = await discoverMarkdownFilesForRoot(root);
    // Code-unit order pins "Z.md" before "a.md" (locale collation would
    // order them the other way); "UPPER.MD" is excluded (exact ".md").
    expect(found.map((entry) => entry.canonicalKey)).toEqual([
      "vault/Z.md",
      "vault/a.md",
      "vault/b.md",
      "vault/sub/c.md",
      "vault/weird.md/inner.md",
    ]);
    for (const entry of found) {
      expect(entry.canonicalKey.startsWith("vault/")).toBe(true);
      expect(entry.canonicalKey).not.toContain("\\");
    }
    expect(JSON.stringify(found)).not.toContain(tmpdir());
  });

  it("uses directory metadata only and no locale-sensitive ordering", () => {
    const source = readFileSync(
      new URL("../src/discovery.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/localeCompare|toLocale[A-Z]|Intl\./);
    expect(source).not.toMatch(/readFile|createReadStream/);
  });

  it("folds internal file symlinks to one canonical key", async (ctx: TestContext) => {
    const dir = scratchVault("md-disc-alias-");
    writeFileSync(join(dir, "real.md"), "# real\n");
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(join(dir, "real.md"), join(dir, "alias.md"), "file"),
      )
    ) {
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const found = await discoverMarkdownFilesForRoot(root);
    expect(found.map((entry) => entry.canonicalKey)).toEqual(["vault/real.md"]);
  });

  it("folds internal directory aliases and terminates on cycles", async (ctx: TestContext) => {
    const dir = scratchVault("md-disc-dir-");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "note.md"), "# note\n");
    const dirType = process.platform === "win32" ? "junction" : "dir";
    const linked = trySymlink(join(dir, "docs"), join(dir, "linked"), dirType);
    const looped = trySymlink(join(dir), join(dir, "docs", "loop"), dirType);
    if (
      !skipUnlessPrivileged(ctx, linked) ||
      !skipUnlessPrivileged(ctx, looped)
    ) {
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const found = await discoverMarkdownFilesForRoot(root);
    expect(found.map((entry) => entry.canonicalKey)).toEqual([
      "vault/docs/note.md",
    ]);
  });

  it("rejects external file symlinks for the whole call", async (ctx: TestContext) => {
    const dir = scratchVault("md-disc-ext-");
    const outside = scratchVault("md-disc-out-");
    writeFileSync(join(outside, "secret.md"), "# secret\n");
    writeFileSync(join(dir, "ok.md"), "# ok\n");
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(join(outside, "secret.md"), join(dir, "evil.md"), "file"),
      )
    ) {
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await discoverMarkdownFilesForRoot(root);
      expect.unreachable("expected markdown_path_unsafe");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_path_unsafe",
      );
      const message = (error as Error).message;
      expect(message).not.toContain(dir);
      expect(message).not.toContain(outside);
      expect(message).not.toContain(tmpdir());
    }
  });

  it("rejects external directory symlinks for the whole call", async (ctx: TestContext) => {
    const dir = scratchVault("md-disc-extdir-");
    const outside = scratchVault("md-disc-extdirout-");
    writeFileSync(join(outside, "x.md"), "# x\n");
    writeFileSync(join(dir, "ok.md"), "# ok\n");
    const dirType = process.platform === "win32" ? "junction" : "dir";
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(outside, join(dir, "linked"), dirType),
      )
    ) {
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await discoverMarkdownFilesForRoot(root);
      expect.unreachable("expected markdown_path_unsafe");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_path_unsafe",
      );
      expect((error as Error).message).not.toContain(tmpdir());
    }
  });

  it("enforces the 10000-file boundary without disk fixtures", () => {
    expect(MAX_FILES_PER_VAULT).toBe(10000);
    expect(() => enforceVaultFileLimit(10000, "vault")).not.toThrow();
    try {
      enforceVaultFileLimit(10001, "vault");
      expect.unreachable("expected markdown_vault_too_large");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_vault_too_large",
      );
      expect((error as Error).message).toContain("vault");
    }
  });

  it("fails before content bytes on 10001 injected entries", async () => {
    const dir = scratchVault("md-disc-limit-");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const names = Array.from({ length: 10001 }, (_, index) => `f${index}.md`);
    try {
      await discoverMarkdownFilesForRoot(root, {
        readdir: () =>
          Promise.resolve(
            names.map((name) => ({
              name,
              isDirectory: false,
              isFile: true,
              isSymbolicLink: false,
            })),
          ),
        realpath: (candidate) => Promise.resolve(candidate),
      });
      expect.unreachable("expected markdown_vault_too_large");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_vault_too_large",
      );
      expect((error as Error).message).not.toContain(tmpdir());
    }
  });

  it("accepts exactly 10000 injected entries, sorted", async () => {
    const dir = scratchVault("md-disc-limitok-");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const names = Array.from({ length: 10000 }, (_, index) => `f${index}.md`);
    const found = await discoverMarkdownFilesForRoot(root, {
      readdir: () =>
        Promise.resolve(
          names.map((name) => ({
            name,
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
          })),
        ),
      realpath: (candidate) => Promise.resolve(candidate),
    });
    const keys = found.map((entry) => entry.canonicalKey);
    expect(keys).toHaveLength(10000);
    expect(keys).toEqual([...keys].sort());
  });

  it("aggregates roots sorted by canonical key", async () => {
    const first = scratchVault("md-disc-multi-a-");
    const second = scratchVault("md-disc-multi-b-");
    writeFileSync(join(first, "z.md"), "# z\n");
    writeFileSync(join(second, "a.md"), "# a\n");
    const roots = await initializeRoots([
      { path: first, alias: "aaa" },
      { path: second, alias: "zzz" },
    ]);
    const found = await discoverMarkdownFiles(roots);
    expect(found.map((entry) => entry.canonicalKey)).toEqual([
      "aaa/z.md",
      "zzz/a.md",
    ]);
  });
});
