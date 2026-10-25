// Trusted offline dependency-depot verification for auto-dispatch.
//
// `dependencyRoot` is NOT a free-form directory marker. It must be the root
// returned by the bridge's real materializer
// (`prepareDependencyClosure`), with its sibling
// `<root>.closure-manifest.json`. The host re-hashes the actual bytes with the
// bridge's own `verifyDependencyClosure` and requires a compiled native
// `better-sqlite3` module plus a pinned Node ABI before any grant may be
// derived. A plain existing directory, a missing/tampered manifest, an
// escaping closure, or an ABI mismatch fails closed as
// `dependency_unavailable`. No install, download, package script, or source
// write happens here.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  hashFileSync,
  verifyDependencyClosure,
} from "../../../scripts/pi-orch-bridge/sealed-profile.mjs";

const MANIFEST_SUFFIX = ".closure-manifest.json";
const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024 * 1024;

export interface VerifiedDependencyDepot {
  readonly root: string;
  readonly manifestPath: string;
  readonly digest: string;
  readonly nodeAbi: number;
  readonly totalBytes: number;
  readonly entryCount: number;
  readonly nativeModules: readonly {
    readonly package: string;
    readonly path: string;
    readonly sha256: string;
  }[];
}

export type DependencyVerification =
  | { readonly ok: true; readonly depot: VerifiedDependencyDepot }
  | {
      readonly ok: false;
      readonly code: "dependency_unavailable";
      readonly reason: string;
    };

interface ClosureManifest {
  schemaVersion?: unknown;
  root?: unknown;
  digest?: unknown;
  nodeAbi?: unknown;
  totalBytes?: unknown;
  entryCount?: unknown;
  nativeModules?: unknown;
}

let cached:
  | {
      readonly root: string;
      readonly manifestMtimeMs: number;
      readonly manifestSize: number;
      readonly result: DependencyVerification;
    }
  | undefined;

function unavailable(reason: string): DependencyVerification {
  return { ok: false, code: "dependency_unavailable", reason };
}

function verifyUncached(rootInput: string): DependencyVerification {
  let root: string;
  try {
    root = realpathSync(rootInput);
  } catch {
    return unavailable("dependency root missing");
  }
  if (root !== rootInput) return unavailable("dependency root is not canonical");
  try {
    if (!statSync(root).isDirectory()) return unavailable("dependency root is not a directory");
  } catch {
    return unavailable("dependency root unreadable");
  }
  const manifestPath = `${root}${MANIFEST_SUFFIX}`;
  try {
    const st = lstatSync(manifestPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) {
      return unavailable("dependency closure manifest invalid");
    }
  } catch {
    return unavailable("dependency closure manifest missing");
  }
  let manifest: ClosureManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ClosureManifest;
  } catch {
    return unavailable("dependency closure manifest unreadable");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.schemaVersion !== 1 ||
    manifest.root !== root ||
    typeof manifest.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.digest) ||
    typeof manifest.nodeAbi !== "number" ||
    !Number.isSafeInteger(manifest.nodeAbi) ||
    manifest.nodeAbi <= 0 ||
    !Array.isArray(manifest.nativeModules) ||
    manifest.nativeModules.length === 0
  ) {
    return unavailable("dependency closure manifest invalid");
  }
  const nativeModules: Array<
    VerifiedDependencyDepot["nativeModules"][number]
  > = [];
  for (const entry of manifest.nativeModules) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { package?: unknown }).package !== "string" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { sha256?: unknown }).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test((entry as { sha256: string }).sha256)
    ) {
      return unavailable("dependency native module entry invalid");
    }
    const rel = (entry as { path: string }).path;
    if (
      rel.startsWith("/") ||
      rel.includes("\\") ||
      rel.includes("\0") ||
      rel.split("/").some((part) => part === ".." || part === "")
    ) {
      return unavailable("dependency native module path invalid");
    }
    const absolute = join(root, rel);
    if (!existsSync(absolute)) return unavailable("dependency native module missing");
    try {
      if (hashFileSync(absolute) !== (entry as { sha256: string }).sha256) {
        return unavailable("dependency native module digest mismatch");
      }
    } catch {
      return unavailable("dependency native module unreadable");
    }
    nativeModules.push({
      package: (entry as { package: string }).package,
      path: rel,
      sha256: (entry as { sha256: string }).sha256,
    });
  }
  if (!nativeModules.some((entry) => entry.package === "better-sqlite3")) {
    return unavailable("dependency closure lacks better-sqlite3");
  }
  let closure: { digest: string; totalBytes: number; entryCount: number };
  try {
    closure = verifyDependencyClosure(
      { root, digest: manifest.digest },
      MAX_DEPENDENCY_BYTES,
    );
  } catch {
    return unavailable("dependency closure digest mismatch");
  }
  return {
    ok: true,
    depot: {
      root,
      manifestPath,
      digest: closure.digest,
      nodeAbi: manifest.nodeAbi,
      totalBytes: closure.totalBytes,
      entryCount: closure.entryCount,
      nativeModules,
    },
  };
}

/** Verify the configured depot; a light mtime/size cache avoids re-hashing
 * unchanged bytes on every readiness/authorize call. A changed manifest
 * invalidates the cache; the closure digest itself is always recomputed when
 * re-verified, so later byte tampering is caught after any manifest change
 * and on process restart. */
export function verifyAutodispatchDependency(
  rootInput: string | null,
): DependencyVerification {
  if (rootInput === null) return unavailable("dependency root not configured");
  let mtimeMs: number;
  let size: number;
  try {
    const st = lstatSync(`${rootInput}${MANIFEST_SUFFIX}`);
    if (!st.isFile() || st.isSymbolicLink()) return unavailable("dependency closure manifest invalid");
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return unavailable("dependency closure manifest missing");
  }
  if (
    cached !== undefined &&
    cached.root === rootInput &&
    cached.manifestMtimeMs === mtimeMs &&
    cached.manifestSize === size
  ) {
    return cached.result;
  }
  const result = verifyUncached(rootInput);
  cached = {
    root: rootInput,
    manifestMtimeMs: mtimeMs,
    manifestSize: size,
    result,
  };
  return result;
}
