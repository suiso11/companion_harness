// Hosted persona-provider API keys (openai / deepseek / opencode).
//
// Keys come from the env at boot and can be replaced at runtime from the
// settings page. A runtime-entered key is persisted OUTSIDE SQLite and the
// frozen config JSON, in a 0600 file under the app-data dir. The file is
// re-read only at startup; a key value never reaches logs, API responses or
// the database. On POSIX a file readable by group/other refuses to load
// (fail closed), mirroring the remote-password file guard.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { HostedPersonaProvider } from "@companion/contracts";
import { parsePersonaProviderKey, ServerConfigError } from "./config.js";

export const PROVIDER_KEYS_FILE_NAME = "provider-keys.json";
const MAX_PROVIDER_KEYS_FILE_BYTES = 64 * 1024;

/** Same order as the contracts provider list (local is not keyed). */
export const HOSTED_PROVIDER_IDS: readonly HostedPersonaProvider[] = [
  "openai",
  "deepseek",
  "opencode",
];

export function isHostedProviderId(
  value: string,
): value is HostedPersonaProvider {
  return (HOSTED_PROVIDER_IDS as readonly string[]).includes(value);
}

export interface ProviderKeyStore {
  /**
   * Live key map. The persona-chat service reads the same object on every
   * call, so `set`/`clear` take effect without a restart.
   */
  readonly keys: Record<HostedPersonaProvider, string | null>;
  /** Persist and activate one key. Throws on an invalid key or write failure. */
  set(provider: HostedPersonaProvider, apiKey: string): void;
  /** Remove one key (memory + file). */
  clear(provider: HostedPersonaProvider): void;
}

function emptyKeys(): Record<HostedPersonaProvider, string | null> {
  return { openai: null, deepseek: null, opencode: null };
}

/**
 * Load file-persisted keys and merge them over the env fallback (an explicit
 * settings-page save wins over the deployment env). Missing file = no keys.
 */
export function createProviderKeyStore(options: {
  filePath: string;
  env: Readonly<Record<HostedPersonaProvider, string | null>>;
}): ProviderKeyStore {
  const { filePath, env } = options;
  const fileKeys = readKeyFile(filePath);
  const keys = emptyKeys();
  const sync = (provider: HostedPersonaProvider): void => {
    keys[provider] = fileKeys[provider] ?? env[provider];
  };
  for (const provider of HOSTED_PROVIDER_IDS) {
    sync(provider);
  }

  // Only UI-saved keys are persisted: an env key stays in the environment so
  // unsetting it still revokes access. `keys` is the file-over-env view.
  const persist = (): void => {
    const payload: Record<string, string> = {};
    for (const provider of HOSTED_PROVIDER_IDS) {
      const apiKey = fileKeys[provider];
      if (apiKey !== undefined) payload[provider] = apiKey;
    }
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
      renameSync(tmp, filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort: the rename may already have consumed the temp file.
      }
      throw error;
    }
  };

  return {
    keys,
    set(provider, apiKey) {
      const parsed = parsePersonaProviderKey(apiKey);
      if (parsed === null) {
        throw new ServerConfigError("persona provider credential is invalid");
      }
      const previous = fileKeys[provider];
      fileKeys[provider] = parsed;
      sync(provider);
      try {
        persist();
      } catch (error) {
        if (previous === undefined) delete fileKeys[provider];
        else fileKeys[provider] = previous;
        sync(provider);
        throw error;
      }
    },
    clear(provider) {
      if (fileKeys[provider] === undefined) return;
      const previous = fileKeys[provider];
      delete fileKeys[provider];
      sync(provider);
      try {
        persist();
      } catch (error) {
        fileKeys[provider] = previous;
        sync(provider);
        throw error;
      }
    },
  };
}

/** Read + validate the key file. Absent means `{}`; anything else is strict. */
function readKeyFile(
  filePath: string,
): Partial<Record<HostedPersonaProvider, string>> {
  const stat = lstatSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined) return {};
  if (!stat.isFile()) {
    throw new ServerConfigError("provider key file is invalid");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ServerConfigError("provider key file permissions are unsafe");
  }
  if (stat.size > MAX_PROVIDER_KEYS_FILE_BYTES) {
    throw new ServerConfigError("provider key file is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new ServerConfigError("provider key file is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServerConfigError("provider key file is invalid");
  }
  const result: Partial<Record<HostedPersonaProvider, string>> = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isHostedProviderId(provider) || typeof value !== "string") {
      throw new ServerConfigError("provider key file is invalid");
    }
    const apiKey = parsePersonaProviderKey(value);
    if (apiKey === null) {
      throw new ServerConfigError("provider key file is invalid");
    }
    result[provider] = apiKey;
  }
  return result;
}
