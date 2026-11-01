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
import { avatarUrl, resolveAvatarFile } from "../src/avatar_files.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-avatar-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveAvatarFile", () => {
  it("resolves the default model file inside the directory", () => {
    const dir = tempDir();
    const file = join(dir, "model.vrm");
    writeFileSync(file, "vrm");
    expect(resolveAvatarFile(dir)).toBe(file);
    expect(avatarUrl(dir)).toBe("/avatar/model.vrm");
  });

  it("returns null when the directory or file is absent", () => {
    expect(resolveAvatarFile(null)).toBeNull();
    expect(resolveAvatarFile(tempDir())).toBeNull();
  });

  it("rejects traversal and non-vrm names", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.vrm"), "vrm");
    expect(resolveAvatarFile(dir, "../model.vrm")).toBeNull();
    expect(resolveAvatarFile(dir, "/etc/passwd")).toBeNull();
    expect(resolveAvatarFile(dir, "model.glb")).toBeNull();
    expect(resolveAvatarFile(dir, "a/b.vrm")).toBeNull();
  });

  it("rejects a symlink pointing outside the directory", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "real.vrm"), "vrm");
    symlinkSync(join(outside, "real.vrm"), join(dir, "link.vrm"));
    expect(resolveAvatarFile(dir, "link.vrm")).toBeNull();
  });

  it("rejects a directory named like a model", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "model.vrm"));
    expect(resolveAvatarFile(dir)).toBeNull();
  });
});
