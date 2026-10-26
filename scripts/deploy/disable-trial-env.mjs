// Failure-path helper for companion-deploy.sh.
//
// A rebuild failure must fail closed (trials off) *without* making the app
// unstartable: apps/server/src/config.ts rejects a configured autodispatch
// whenever the trial config is absent. So instead of emptying autonomy.env,
// reuse the previous valid trial config with `enabled: false`. When no usable
// previous config exists, emit nothing (the caller then empties the file).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { formatAutonomyEnvLine } from "./trialOperator.mjs";

const ENV_LINE_RE = /^COMPANION_AUTONOMY_JSON='([^']*)'[ \t]*$/m;

export function disableTrialEnv(text) {
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
    process.stdout.write(
      disableTrialEnv(readFileSync(process.argv[2], "utf8")),
    );
  } catch {
    process.exit(1);
  }
}
