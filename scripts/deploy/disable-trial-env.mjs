// Failure-path helper for companion-deploy.sh.
//
// A rebuild failure must fail closed (trials off) *without* making the app
// unstartable: apps/server/src/config.ts rejects a configured autodispatch
// whenever the trial config is absent. So instead of emptying autonomy.env,
// reuse the previous valid trial config with `enabled: false`. When no usable
// previous config exists, emit nothing (the caller then empties the file).
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  formatAutonomyEnvLine,
  resolveCurrentModel,
} from "./trialOperator.mjs";

const ENV_LINE_RE = /^COMPANION_AUTONOMY_JSON='([^']*)'[ \t]*$/m;

export function disableTrialEnv(
  text,
  { env = process.env, litellmEnvText = null } = {},
) {
  if (typeof text !== "string") return "";
  const match = ENV_LINE_RE.exec(text);
  if (!match) return "";
  let doc;
  try {
    doc = JSON.parse(match[1]);
  } catch {
    return "";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return "";
  }
  doc.enabled = false;
  // A disabled trial config is still validated against the server's effective
  // model, so rebind it with the same resolver the builder uses. Without this,
  // a model change plus a failed rebuild makes the app unstartable.
  try {
    doc.currentModel = resolveCurrentModel(env, litellmEnvText);
  } catch {
    return "";
  }
  try {
    return formatAutonomyEnvLine(JSON.stringify(doc));
  } catch {
    return "";
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const litellmPath = process.argv[3];
    const litellmEnvText =
      typeof litellmPath === "string" && existsSync(litellmPath)
        ? readFileSync(litellmPath, "utf8")
        : null;
    process.stdout.write(
      disableTrialEnv(readFileSync(process.argv[2], "utf8"), {
        env: process.env,
        litellmEnvText,
      }),
    );
  } catch {
    process.exit(1);
  }
}
