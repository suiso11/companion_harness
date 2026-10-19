// Types for the plain-JS active-run gate (scripts/deploy/activeRuns.mjs).

export declare const ACTIVE_STATUSES: readonly string[];

export declare function resolveDbPath(env?: NodeJS.ProcessEnv): string;

export declare function countActiveRuns(dbPath: string): Promise<{
  db: string;
  active: number;
  note?: string;
}>;
