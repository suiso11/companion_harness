// Local VRM avatar file resolution (character page).
//
// The user supplies the model (a BOOTH/VRChat VRM) outside the repository;
// the server only serves that one directory under `/avatar/<file>`. The
// checks are deliberately strict: an absolute file name, a `.vrm`
// extension, and canonical containment (symlinks resolved) before any read.

import { realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

/** File name served by default (the character page asks for this one). */
export const DEFAULT_AVATAR_FILE = "model.vrm";

const FILE_NAME = /^[A-Za-z0-9._-]+\.vrm$/;

/**
 * Absolute path of `<dir>/<name>` when it is a real `.vrm` file inside the
 * configured directory; null otherwise (missing dir, traversal, symlink out,
 * wrong extension, non-file).
 */
export function resolveAvatarFile(
  dir: string | null,
  name: string = DEFAULT_AVATAR_FILE,
): string | null {
  if (dir === null || !FILE_NAME.test(name)) {
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
    return statSync(realTarget).isFile() ? realTarget : null;
  } catch {
    return null;
  }
}

/** Same-origin URL the character page loads, or null when no model exists. */
export function avatarUrl(dir: string | null): string | null {
  const file = resolveAvatarFile(dir);
  return file === null ? null : `/avatar/${basename(file)}`;
}
