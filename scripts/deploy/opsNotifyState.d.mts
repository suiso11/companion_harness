// Types for the plain-JS notify dedupe helper (scripts/deploy/opsNotifyState.mjs).

export declare const SKIP_WINDOW_MS: number;

export interface SkipEntry {
  readonly firstSkipAt: number;
  readonly lastNotifiedAt: number;
}

export interface SkipState {
  readonly targets?: Record<string, SkipEntry>;
}

export interface HealthState {
  readonly keys?: Record<string, number>;
}

export declare function nextSkipState(
  state: SkipState | undefined,
  target: string,
  now: number,
  windowMs?: number,
): { state: SkipState; notify: boolean };

export declare function clearSkipState(
  state: SkipState | undefined,
  target: string,
): SkipState;

export declare function nextHealthState(
  state: HealthState | undefined,
  key: string,
  failing: boolean,
  now: number,
): { state: HealthState; level: "error" | "recovered" | null };

export declare function defaultStatePath(
  name: string,
  env?: NodeJS.ProcessEnv,
): string;

export declare function runCli(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  now?: number,
): "notify" | "silent" | "ok" | "error" | "recovered" | "usage";
