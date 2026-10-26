export interface ContainmentRuntime {
  bwrapRealpath?: string;
  systemdRunRealpath?: string;
  systemctlRealpath?: string;
  nodeRealpath?: string;
  ompRealpath?: string;
  piOrchLauncherRealpath?: string;
  piOrchShellRealpath?: string;
  piOrchConfigRealpath?: string;
  piOrchExtensionRealpath?: string;
  [key: string]: string | undefined;
}

export interface ContainmentProfile {
  executor: { kind?: string; executable: string; args: string[] };
  runtime: ContainmentRuntime;
  limits: Record<string, number>;
  model: { sockHostPath: string };
  dependencies: { mounts: readonly { source: string; guestPath: string }[] };
}

export interface ContainmentCommand {
  command: string;
  args: string[];
}

export interface ObservedResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export function preflightContainment(
  runtime: ContainmentRuntime,
): { ok: true } | { ok: false; reason: string };

export function materializeSealedWork(
  snapshotRoot: string,
  workRoot: string,
): string;

export function guestPathEnvironment(profile: ContainmentProfile): string;

export function buildWholejobCommand(
  profile: ContainmentProfile,
  paths: {
    executorExecutable: string;
    workRoot: string;
    jobFile: string;
  },
  scopeUnit: string,
  options?: { guestTimeoutMs?: number },
): ContainmentCommand;

export function buildCheckCommand(
  profile: ContainmentProfile,
  paths: { workRoot: string; scratchRoot: string },
  scopeUnit: string,
  check: { executable: string; args: string[] },
): ContainmentCommand;

export function stopOwnedScope(
  runtime: { systemctlRealpath: string },
  unit: string,
  signal: string,
): void;

export function spawnObserved(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    onChild?: (child: unknown) => void;
    outputCap?: number;
  },
): Promise<ObservedResult>;

export function createJobFile(path: string, job: unknown): string;

export function copyBoundedFile(
  source: string,
  destination: string,
  maxBytes: number,
): boolean;
