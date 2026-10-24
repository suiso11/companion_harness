// Types for the plain-JS remind online backup helper.

export declare const DEFAULT_KEEP: number;
export declare const FILE_MODE: number;
export declare const DIR_MODE: number;

export declare function formatUtc(now?: Date): string;
export declare function resolveRemindDbPath(configPath: string): string;
export declare function defaultConfigPath(env?: NodeJS.ProcessEnv): string;

export interface Generation {
  name: string;
  path: string;
  mtimeMs: number;
}

export declare function listGenerations(
  dir: string,
  prefix?: string,
): Generation[];

export declare function pruneGenerations(
  dir: string,
  keep?: number,
  protect?: string,
  prefix?: string,
): string[];

export declare function backupDb(options: {
  dbPath: string;
  outDir: string;
  keep?: number;
  prefix?: string;
  suffix?: string;
  now?: Date;
}): Promise<{
  file: string;
  path: string;
  removed: string[];
  userVersion: number;
}>;

export declare function backupRemindDb(options?: {
  configPath?: string;
  outDir?: string;
  keep?: number;
  prefix?: string;
  suffix?: string;
  now?: Date;
}): Promise<{
  file: string;
  path: string;
  removed: string[];
  userVersion: number;
}>;

export declare const PREDEPLOY_PREFIX: string;
export declare const PREDEPLOY_KEEP: number;

export declare function backupRemindPreDeploy(options?: {
  configPath?: string;
  sha: string;
  keep?: number;
  now?: Date;
}): Promise<
  | { skipped: true; reason: string; dbPath: string }
  | {
      skipped: false;
      dbPath: string;
      file: string;
      path: string;
      removed: string[];
      userVersion: number;
    }
>;
