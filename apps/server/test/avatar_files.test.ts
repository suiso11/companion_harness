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
import {
  avatarConfig,
  resolveAvatarBrotli,
  resolveAvatarFile,
} from "../src/avatar_files.js";

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
  it("resolves a whitelisted file with its content type", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.fbx"), "fbx");
    writeFileSync(join(dir, "textures.json"), "{}");
    writeFileSync(join(dir, "Body.png"), "png");
    expect(resolveAvatarFile(dir, "model.fbx")).toEqual({
      path: join(dir, "model.fbx"),
      contentType: "application/octet-stream",
    });
    expect(resolveAvatarFile(dir, "textures.json")?.contentType).toBe(
      "application/json",
    );
    expect(resolveAvatarFile(dir, "Body.png")?.contentType).toBe("image/png");
  });

  it("returns null when the directory or file is absent", () => {
    expect(resolveAvatarFile(null, "model.fbx")).toBeNull();
    expect(resolveAvatarFile(tempDir(), "model.fbx")).toBeNull();
  });

  it("rejects traversal and non-whitelisted names", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.fbx"), "fbx");
    expect(resolveAvatarFile(dir, "../model.fbx")).toBeNull();
    expect(resolveAvatarFile(dir, "/etc/passwd")).toBeNull();
    expect(resolveAvatarFile(dir, "model.exe")).toBeNull();
    expect(resolveAvatarFile(dir, "a/b.fbx")).toBeNull();
  });

  it("rejects a symlink pointing outside the directory", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "real.fbx"), "fbx");
    symlinkSync(join(outside, "real.fbx"), join(dir, "link.fbx"));
    expect(resolveAvatarFile(dir, "link.fbx")).toBeNull();
  });

  it("rejects a directory named like a model", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "model.fbx"));
    expect(resolveAvatarFile(dir, "model.fbx")).toBeNull();
  });
});

describe("resolveAvatarBrotli", () => {
  it("returns the pre-compressed sibling when present", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.fbx"), "fbx");
    writeFileSync(join(dir, "model.fbx.br"), "br");
    expect(resolveAvatarBrotli(dir, "model.fbx")).toBe(
      join(dir, "model.fbx.br"),
    );
    expect(resolveAvatarBrotli(dir, "model.vrm")).toBeNull();
  });
});

describe("avatarConfig", () => {
  it("prefers a VRM over an FBX", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.fbx"), "fbx");
    writeFileSync(join(dir, "model.vrm"), "vrm");
    expect(avatarConfig(dir)).toMatchObject({
      kind: "vrm",
      url: expect.stringMatching(/^\/avatar\/model\.vrm\?v=\d+$/),
      texturesUrl: null,
    });
  });

  it("reports the FBX and its texture mapping", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "model.fbx"), "fbx");
    writeFileSync(join(dir, "textures.json"), "{}");
    expect(avatarConfig(dir)).toMatchObject({
      kind: "fbx",
      url: expect.stringMatching(/^\/avatar\/model\.fbx\?v=\d+$/),
      texturesUrl: expect.stringMatching(/^\/avatar\/textures\.json\?v=\d+$/),
    });
  });

  it("returns null without a model", () => {
    expect(avatarConfig(null)).toBeNull();
    expect(avatarConfig(tempDir())).toBeNull();
  });
});
