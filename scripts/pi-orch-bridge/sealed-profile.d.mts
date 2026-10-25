export const PROFILE_SCHEMA_VERSION: number;
export const PROFILE_MAX_DURATION_MS: number;
export interface OperatorConfig {
  version: number;
  stateDir: string;
  storage: { maxRequestBytes: number; maxArtifactBytes: number; maxResultBytes: number; maxDbBytes: number };
  active: { configFingerprint: string; sourceRevision: string; workspaceAlias: string };
  sealed: { rootDir: string; snapshotRoot: string; manifestPath: string; manifestDigest: string; pristineSnapshotRoot: string; sourceRootOriginal: string };
  profile: {
    executionBackend: "confined" | "offline-fixture";
    executor: { kind?: "fixed" | "pi-orch-guest" | "real-pi"; executable: string; args: string[]; contentDigest: string };
    checks: Record<string, { executable: string; args: string[]; contentDigest: string; expectExitCode: number; expectStdoutIncludes?: string }>;
    runtime: Partial<Record<"nodeRealpath" | "ompRealpath" | "bwrapRealpath" | "systemdRunRealpath" | "systemctlRealpath" | "piOrchLauncherRealpath" | "piOrchShellRealpath" | "piOrchConfigRealpath" | "piOrchExtensionRealpath" | "piOrchLockRealpath", string>>;
    model: { route: "local" | "synthetic-local" | "external"; sockHostPath: string; externalConsent: boolean };
    limits: Record<string, number>;
    allowedPaths: string[];
    scratchPaths: string[];
    dependencies: { root: string; manifestPath: string; digest: string; nodeAbi?: number; mounts: { source: string; guestPath: string }[] };
  };
}
export interface EffectiveProfile {
  fingerprint: string;
  effective: unknown;
  sourceRevision: string;
  executorDigest: string;
  checks: unknown;
  runtime: unknown;
}
export function parseOperatorConfig(text: string): OperatorConfig;
export function computeEffectiveProfile(config: OperatorConfig): EffectiveProfile;
export function assertProfileMatches(config: OperatorConfig, effective: EffectiveProfile): void;
export function loadSealedSnapshot(config: OperatorConfig, options?: { expectedManifestDigest?: string }): unknown;
export function computeDependencyClosureDigest(root: string, maxBytes: number): { digest: string; totalBytes: number; entryCount: number };
export function verifyDependencyClosure(deps: { root: string; digest: string }, maxBytes: number): { digest: string; totalBytes: number; entryCount: number };
export function assertConsent(profile: unknown, request: unknown): void;
export function assertRequestScopes(profile: unknown, request: unknown): void;
export function assertRequestBudget(profile: unknown, request: unknown): void;
export function hashFileSync(path: string): string;
export function sourceRevisionForManifest(manifestDigest: string): string;
