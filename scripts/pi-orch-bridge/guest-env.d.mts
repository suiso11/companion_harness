export const FORWARDED_ENV_MAX_BYTES: number;
export function parseForwardedGuestEnv(text: string): Record<string, string>;
export function readForwardedGuestEnv(path: string): Record<string, string>;
export function writeGuestEnvSnapshot(
  path: string,
  names: string[],
  env: Record<string, string | undefined>,
): Record<string, string>;
