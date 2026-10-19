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
): string[];

export declare function backupRemindDb(options?: {
  configPath?: string;
  outDir?: string;
  keep?: number;
  now?: Date;
}): Promise<{ file: string; path: string; removed: string[] }>;
