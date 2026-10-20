// Types for the plain-JS remind deploy helper (scripts/deploy/remindDeploy.mjs).

export declare function memoryValue(
  raw: string | undefined,
  key: string,
): string | null;

export declare function scopeFromMemoryJson(
  raw: string | undefined,
): string | null;

export declare function readAllowedScope(
  configPath: string | undefined,
): string | null;

export declare function resolveSmokeScope(options?: {
  memoryJson?: string;
  configPath?: string;
}): string | null;

export declare function resolveSmokeTarget(options?: {
  memoryJson?: string;
  configPath?: string;
  fallbackEntry?: string;
  fallbackExecutable?: string;
}): {
  executable: string | null;
  entry: string | null;
  config: string | null;
  scope: string | null;
};

export declare function isOkEnvelope(raw: string): boolean;
