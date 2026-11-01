// Local avatar assets (character page).
//
// The user supplies the model (a VRM, GLB, or the raw FBX from a BOOTH
// package) outside the repository; the server serves exactly that one
// directory under `/avatar/<file>`. The checks are deliberately strict: an
// absolute file name, a whitelisted extension, and canonical containment
// (symlinks resolved) before any read.

import { realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";

/** Model file names checked in order; the first present wins. */
export const AVATAR_MODEL_FILES = ["model.vrm", "model.fbx"] as const;
/** Optional material → texture mapping for the FBX path. */
export const AVATAR_TEXTURES_FILE = "textures.json";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".vrm": "model/gltf-binary",
  ".glb": "model/gltf-binary",
  ".fbx": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

const FILE_NAME = /^[A-Za-z0-9._-]+$/;

export interface AvatarFile {
  readonly path: string;
  readonly contentType: string;
}

/** `<dir>/<name>` when it is a real whitelisted file inside the directory. */
export function resolveAvatarFile(
  dir: string | null,
  name: string,
): AvatarFile | null {
  if (dir === null || !FILE_NAME.test(name)) {
    return null;
  }
  const contentType = CONTENT_TYPES[extname(name).toLowerCase()];
  if (contentType === undefined) {
    return null;
  }
  const root = resolve(dir);
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) {
    return null;
  }
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realRoot + sep)) {
      return null;
    }
    return statSync(realTarget).isFile()
      ? { path: realTarget, contentType }
      : null;
  } catch {
    return null;
  }
}

export type AvatarKind = "vrm" | "fbx";

export interface AvatarConfig {
  readonly kind: AvatarKind;
  readonly url: string;
  /** Present when the FBX path has a `textures.json` mapping. */
  readonly texturesUrl: string | null;
}

/** What the character page should load, or null when no model exists. */
export function avatarConfig(dir: string | null): AvatarConfig | null {
  if (dir === null) {
    return null;
  }
  for (const name of AVATAR_MODEL_FILES) {
    const file = resolveAvatarFile(dir, name);
    if (file === null) {
      continue;
    }
    const kind = extname(name).slice(1) as AvatarKind;
    const textures = resolveAvatarFile(dir, AVATAR_TEXTURES_FILE);
    return {
      kind,
      url: `/avatar/${basename(file.path)}`,
      texturesUrl: textures === null ? null : `/avatar/${AVATAR_TEXTURES_FILE}`,
    };
  }
  return null;
}
