import type { EffectiveProfile, OperatorConfig } from "./sealed-profile.mjs";

export interface PreparedSnapshot {
  schemaVersion: number;
  canonicalRoot: string;
  snapshotRoot: string;
  manifestPath: string;
  manifest: readonly unknown[];
  manifestDigest: string;
  sourceIdentity: unknown;
  maxSourceBytes: number;
  maxArtifactBytes: number;
  maxFiles: number;
}

export interface PrepareDependencyClosureOptions {
  sourceNodeModules: string;
  destinationRoot: string;
  maxBytes?: number;
  maxEntries?: number;
  requiredPackages?: readonly string[];
  nodeRealpath?: string;
  expectedNodeAbi?: number;
}

export interface DependencyClosureResult {
  root: string;
  manifestPath: string;
  digest: string;
  nodeAbi: number | null;
  totalBytes: number;
  entryCount: number;
  nativeModules: readonly {
    package: string;
    path: string;
    size: number;
    sha256: string;
    nodeAbi: number | null;
  }[];
  mounts: readonly { source: string; guestPath: string }[];
}

export interface PrepareExecutorProfileOptions {
  snapshotRoot: string;
  snapshotManifestPath?: string;
  expectedManifestDigest: string;
  sealedRoot: string;
  pristineSnapshotRoot: string;
  sourceRootOriginal: string;
  stateDir: string;
  modelUDS: string;
  workspaceAlias?: string;
  storage?: Record<string, number>;
  policy: unknown;
}

export interface BuildBridgeExecConfigOptions
  extends PrepareExecutorProfileOptions {
  configPath?: string;
}

export function prepareDependencyClosure(
  options: PrepareDependencyClosureOptions,
): DependencyClosureResult;

export function prepareExecutorProfile(
  options: PrepareExecutorProfileOptions,
): Promise<{
  config: OperatorConfig;
  effective: EffectiveProfile;
  snapshot: PreparedSnapshot;
}>;

export function buildBridgeExecConfig(
  options: BuildBridgeExecConfigOptions,
): Promise<{
  config: OperatorConfig;
  configPath: string;
  effective: EffectiveProfile;
  snapshot: PreparedSnapshot;
}>;

export const MANIFEST_SUFFIX: string;
