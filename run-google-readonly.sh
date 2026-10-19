#!/bin/sh
# Durable local run: Companion Harness + pinned google-readonly Calendar.
# Convention: env-only config (no committed secrets); this script only
# generates COMPANION_CALENDAR_JSON per docs/operations.md (C14 profile)
# and execs `pnpm start`. Secrets stay in the environment (never embedded
# here, never logged): GOOGLE_OAUTH_CREDENTIALS, GOOGLE_ACCOUNT_MODE.
# Actions stay disabled (COMPANION_ACTIONS_JSON unset -> optIn/writeEnabled
# false). Model defaults to the existing local LiteLLM proxy via the private
# ignored runtime file .env.litellm (0600, never committed/logged) when
# COMPANION_MODEL_JSON is not already exported; without either, runs fail
# closed but health + calendar registration stay verifiable.
set -eu
COMPANION_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
FORK_DIR="${FORK_DIR:-$HOME/gcal-readonly}"
ACCT="${GOOGLE_ACCOUNT_MODE:-normal}"
COMPANION_PORT="${COMPANION_PORT:-3000}"
export GOOGLE_OAUTH_CREDENTIALS="${GOOGLE_OAUTH_CREDENTIALS:-$HOME/gcal-readonly/gcp-oauth.keys.json}"
export GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH="${GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH:-$HOME/.config/google-calendar-mcp-readonly/tokens.json}"
export GOOGLE_ACCOUNT_MODE="$ACCT"
export COMPANION_CALENDAR_PROFILE=google-readonly
export COMPANION_PORT
export FORK_DIR ACCT
# Launch safety: never inherit action opt-in from the calling shell.
unset COMPANION_ACTIONS_JSON
# Model: prefer an already-exported COMPANION_MODEL_JSON; otherwise build it
# from the private ignored runtime file (existing LiteLLM proxy, no new keys).
if [ -z "${COMPANION_MODEL_JSON:-}" ]; then
  _LITELLM_ENV_FILE="$COMPANION_DIR/.env.litellm"
  if [ -f "$_LITELLM_ENV_FILE" ]; then
    _LITELLM_KEY="$(sed -n 's/^LITELLM_MASTER_KEY=//p' "$_LITELLM_ENV_FILE" | head -n 1 | tr -d '\r\n')"
    if [ -n "$_LITELLM_KEY" ]; then
      COMPANION_MODEL_JSON="$(LITELLM_MASTER_KEY="$_LITELLM_KEY" node --input-type=module -e 'const k=process.env.LITELLM_MASTER_KEY??"";process.stdout.write(JSON.stringify({adapter:"openai-compatible",baseUrl:"http://127.0.0.1:4000",model:"local-chat",apiKey:k}));')"
      export COMPANION_MODEL_JSON
    fi
    unset _LITELLM_KEY
  fi
  unset _LITELLM_ENV_FILE
fi
export COMPANION_CALENDAR_JSON="$(node --input-type=module -e '
import os from "node:os";
import path from "node:path";
const forkDir = process.env.FORK_DIR ?? "";
const account = process.env.ACCT ?? "";
const posixBase = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
const winBase = ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"];
const base = os.platform() === "win32" ? winBase : posixBase;
const doc = {
  selection: account === "" ? { calendarId: "primary" } : { calendarId: "primary", account },
  connector: {
    serverId: "calendar-readonly",
    kind: "mcp",
    expectedServerName: "google-calendar",
    version: "3.0.0-readonly.2",
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: [path.resolve(forkDir, "build", "index.js"), "--enable-tools", "list-events,search-events,get-event"],
      envAllowlist: [...base, "GOOGLE_OAUTH_CREDENTIALS", "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH", "GOOGLE_ACCOUNT_MODE"],
    },
    bindings: [
      { upstreamTool: "list-events", canonicalSchemaHash: "01c3d647c272fdbd0de1028f73c76cd8baab931f177733146cd6287b9683d1fe" },
      { upstreamTool: "search-events", canonicalSchemaHash: "d94166b755b694710c925fcc96e6ecff1016ea53f470264428494656791be7f6" },
      { upstreamTool: "get-event", canonicalSchemaHash: "8c6736e2a1f397d0735efa5c0881f5c350c300b21a0b026e80c112258b596bda" },
    ],
  },
};
process.stdout.write(JSON.stringify(doc));
' )"
cd "$COMPANION_DIR"
exec pnpm start
