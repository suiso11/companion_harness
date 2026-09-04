import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { describe, expect, it } from "vitest";
import { discoverMarkdownFilesForRoot } from "../src/discovery.js";
import { MarkdownConnectorError } from "../src/errors.js";
import { type InitializedRoot, initializeRoots } from "../src/roots.js";
import {
  isNoFollowSupported,
  MAX_FILE_BYTES,
  safeReadMarkdownFile,
} from "../src/safe_read.js";

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
 * error and propagates, so privilege skips stay narrow.
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

function expectConnectorError(
  error: unknown,
  code:
    | "markdown_path_unsafe"
    | "markdown_read_failed"
    | "markdown_read_changed",
  dir: string,
): void {
  expect(error).toBeInstanceOf(MarkdownConnectorError);
  expect((error as MarkdownConnectorError).code).toBe(code);
  expect((error as Error).message).not.toContain(dir);
  expect((error as Error).message).not.toContain(tmpdir());
}

describe("safe read", () => {
  it("reads a discovered file and normalizes to NFC", async () => {
    const dir = scratchVault("md-read-ok-");
    writeFileSync(join(dir, "note.md"), "# café\n".normalize("NFD"));
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const found = await discoverMarkdownFilesForRoot(root);
    expect(found.map((entry) => entry.canonicalKey)).toEqual(["vault/note.md"]);
    const result = await safeReadMarkdownFile(root, "vault/note.md");
    expect(result).toEqual({
      status: "ok",
      canonicalKey: "vault/note.md",
      text: "# café\n",
    });
  });

  it("reads an empty file as empty evidence", async () => {
    const dir = scratchVault("md-read-empty-");
    writeFileSync(join(dir, "empty.md"), "");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    expect(await safeReadMarkdownFile(root, "vault/empty.md")).toEqual({
      status: "ok",
      canonicalKey: "vault/empty.md",
      text: "",
    });
  });

  it("rejects malformed keys as path-unsafe without echoing paths", async () => {
    const dir = scratchVault("md-read-keys-");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const badKeys = [
      "vault/../evil.md",
      "vault/",
      "vault/a/./b.md",
      "vault//b.md",
      "other/note.md",
      "/etc/passwd.md",
      "vault\\note.md",
    ];
    for (const badKey of badKeys) {
      try {
        await safeReadMarkdownFile(root, badKey);
        expect.unreachable(`expected markdown_path_unsafe for ${badKey}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MarkdownConnectorError);
        expect((error as MarkdownConnectorError).code).toBe(
          "markdown_path_unsafe",
        );
        const message = (error as Error).message;
        expect(message).not.toContain(dir);
        expect(message).not.toContain(tmpdir());
        expect(message).not.toContain("/etc/passwd");
      }
    }
  });

  it("fails a missing file without raw OS errors", async () => {
    const dir = scratchVault("md-read-missing-");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/gone.md");
      expect.unreachable("expected markdown_read_failed");
    } catch (error) {
      expectConnectorError(error, "markdown_read_failed", dir);
      expect((error as Error).message).toContain("vault/gone.md");
    }
  });

  it("fails a directory target", async () => {
    const dir = scratchVault("md-read-dir-");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/sub");
      expect.unreachable("expected markdown_read_failed");
    } catch (error) {
      expectConnectorError(error, "markdown_read_failed", dir);
    }
  });

  it("pre-skips oversize files on metadata alone", async () => {
    const dir = scratchVault("md-read-big-");
    writeFileSync(join(dir, "big.md"), "x".repeat(MAX_FILE_BYTES + 16));
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    expect(await safeReadMarkdownFile(root, "vault/big.md")).toEqual({
      status: "skipped",
      canonicalKey: "vault/big.md",
      reason: "file_too_large",
    });
  });

  it("accepts exactly 1MiB and skips 1MiB+1", async () => {
    const dir = scratchVault("md-read-bound-");
    writeFileSync(join(dir, "exact.md"), "a".repeat(MAX_FILE_BYTES));
    writeFileSync(join(dir, "over.md"), "a".repeat(MAX_FILE_BYTES + 1));
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const exact = await safeReadMarkdownFile(root, "vault/exact.md");
    expect(exact.status).toBe("ok");
    expect(await safeReadMarkdownFile(root, "vault/over.md")).toEqual({
      status: "skipped",
      canonicalKey: "vault/over.md",
      reason: "file_too_large",
    });
  });

  it("skips invalid UTF-8 explicitly", async () => {
    const dir = scratchVault("md-read-utf8-");
    writeFileSync(
      join(dir, "bad.md"),
      Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]),
    );
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    expect(await safeReadMarkdownFile(root, "vault/bad.md")).toEqual({
      status: "skipped",
      canonicalKey: "vault/bad.md",
      reason: "invalid_utf8",
    });
  });

  it("rejects replacement between pre-stat and open", async () => {
    const dir = scratchVault("md-read-swap-");
    const file = join(dir, "swap.md");
    writeFileSync(file, "# original\n");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/swap.md", {
        afterPreStat: () => {
          renameSync(file, `${file}.orig`);
          writeFileSync(file, "# replacement\n");
        },
      });
      expect.unreachable("expected markdown_read_changed");
    } catch (error) {
      // New inode: the pre-read fstat compare fires before any byte flows.
      expectConnectorError(error, "markdown_read_changed", dir);
    }
  });

  it("rejects in-place mutation between read and post-check", async () => {
    const dir = scratchVault("md-read-mutate-");
    const file = join(dir, "mut.md");
    writeFileSync(file, "# stable\n");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/mut.md", {
        afterRead: () => {
          appendFileSync(file, "trailing\n");
        },
      });
      expect.unreachable("expected markdown_read_changed");
    } catch (error) {
      // Same inode but size/mtime moved: post-fstat rejects, bytes dropped.
      expectConnectorError(error, "markdown_read_changed", dir);
    }
  });

  it("caps growth between pre-stat and open as file_too_large", async () => {
    const dir = scratchVault("md-read-grow-");
    const file = join(dir, "grow.md");
    writeFileSync(file, "start\n");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const result = await safeReadMarkdownFile(root, "vault/grow.md", {
      afterPreStat: () => {
        appendFileSync(file, "y".repeat(MAX_FILE_BYTES));
      },
    });
    // Same inode, so the pre-read identity holds; bounded chunk reads stop
    // at 1MiB+1 and report an explicit skip instead of truncating.
    expect(result).toEqual({
      status: "skipped",
      canonicalKey: "vault/grow.md",
      reason: "file_too_large",
    });
  });

  it("rejects reads through external symlinks", async (ctx: TestContext) => {
    const dir = scratchVault("md-read-ext-");
    const outside = scratchVault("md-read-extout-");
    writeFileSync(join(outside, "secret.md"), "# secret\n");
    writeFileSync(join(dir, "ok.md"), "# ok\n");
    if (
      trySymlink(join(outside, "secret.md"), join(dir, "link.md"), "file") ===
      "privilege-denied"
    ) {
      ctx.skip();
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/link.md");
      expect.unreachable("expected markdown_path_unsafe");
    } catch (error) {
      expectConnectorError(error, "markdown_path_unsafe", dir);
    }
  });

  it("traps a final-component symlink swap", async (ctx: TestContext) => {
    const dir = scratchVault("md-read-trap-");
    const outside = scratchVault("md-read-trapout-");
    const file = join(dir, "target.md");
    writeFileSync(file, "# original\n");
    writeFileSync(join(outside, "other.md"), "# other\n");
    // Probe privilege first so the hook below never needs to skip mid-read.
    const probeDir = scratchVault("md-read-probe-");
    writeFileSync(join(probeDir, "t.md"), "x");
    if (
      trySymlink(join(probeDir, "t.md"), join(probeDir, "l.md"), "file") ===
      "privilege-denied"
    ) {
      ctx.skip();
      return;
    }
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    try {
      await safeReadMarkdownFile(root, "vault/target.md", {
        afterPreStat: () => {
          renameSync(file, `${file}.orig`);
          symlinkSync(join(outside, "other.md"), file, "file");
        },
      });
      expect.unreachable("expected unsafe/changed rejection");
    } catch (error) {
      if (isNoFollowSupported()) {
        // ELOOP trap on the swapped final component.
        expectConnectorError(error, "markdown_path_unsafe", dir);
      } else {
        // No O_NOFOLLOW here: the open follows the plant, but the pre-read
        // fstat identity compare still rejects before bytes are consumed.
        expectConnectorError(error, "markdown_read_changed", dir);
      }
    }
  });

  it("never buffers unboundedly and avoids locale-sensitive code", () => {
    const source = readFileSync(
      new URL("../src/safe_read.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/readFile|createReadStream/);
    expect(source).not.toMatch(/localeCompare|toLocale[A-Z]/);
  });

  it("aborts before the first byte when the signal is already aborted", async () => {
    const dir = scratchVault("md-read-abortbefore-");
    writeFileSync(join(dir, "note.md"), "# hello\n");
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    let hookCalls = 0;
    const counting = () => {
      hookCalls += 1;
    };
    const controller = new AbortController();
    controller.abort();
    try {
      await safeReadMarkdownFile(root, "vault/note.md", {
        signal: controller.signal,
        afterPreStat: counting,
        afterOpen: counting,
        afterRead: counting,
      });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(tmpdir());
      expect(String(error)).not.toContain("note.md");
    }
    expect(hookCalls).toBe(0);
  });

  it("aborts during chunk reads and discards buffered bytes", async () => {
    const dir = scratchVault("md-read-abortchunk-");
    // Multi-chunk file so the per-chunk checkpoint fires after afterOpen.
    writeFileSync(join(dir, "long.md"), "a".repeat(200_000));
    const root = onlyRoot(
      await initializeRoots([{ path: dir, alias: "vault" }]),
    );
    const controller = new AbortController();
    try {
      await safeReadMarkdownFile(root, "vault/long.md", {
        signal: controller.signal,
        afterOpen: () => {
          controller.abort();
        },
      });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      // No path, no content: only the generic abort message escapes.
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(tmpdir());
      expect(String(error)).not.toContain("long.md");
      expect(String(error)).not.toContain("aaa");
    }
    // The handle was closed (finally) and nothing was returned: a later
    // non-aborted read still succeeds deterministically.
    const retry = await safeReadMarkdownFile(root, "vault/long.md");
    expect(retry.status).toBe("ok");
  });
});
