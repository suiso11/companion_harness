#!/bin/sh
# Polling auto-deploy for the remind CLI (single Linux host, user systemd,
# no inbound webhook). Run by remind-deploy.timer.
#
# Policy: advance $REMIND_DEPLOY_DIR (default ~/remind_master, a detached
# worktree) to origin/master ONLY when the target commit is green in CI and
# Companion has no run in flight. The remind CLI is spawned per call, so a
# rebuild mid-call is the only disruption; there is no long-lived remind
# process to restart. Never discards local changes; rolls back to the
# previous sha (rebuilding it) when the new revision fails its smoke test.
#
# Logs go to stdout (journal). No secrets are printed.
# Single-instance via flock. Exit 0 = up-to-date or clean skip (retry next
# tick); exit 1 = refused (dirty tree) or failed (rollback attempted).
set -eu

DEPLOY_DIR="${REMIND_DEPLOY_DIR:-$HOME/remind_master}"
REPO_OWNER="${REMIND_DEPLOY_REPO_OWNER:-suiso11}"
REPO_NAME="${REMIND_DEPLOY_REPO_NAME:-remind}"
REMIND_CONFIG="${REMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/remind/memory.config.json}"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/remind-deploy.lock"

log() {
  printf '%s remind-deploy: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# systemd loads EnvironmentFile; manual runs fall back to reading the one
# COMPANION_MEMORY_JSON line (never echoed) so the smoke call matches the
# exact executable/entry/config/scope Companion uses.
load_memory_json() {
  if [ -n "${COMPANION_MEMORY_JSON:-}" ]; then
    return 0
  fi
  _env_file="${COMPANION_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/companion/env}"
  [ -r "$_env_file" ] || return 0
  _line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPANION_MEMORY_JSON=' \
    "$_env_file" | tail -n 1 || true)"
  [ -n "$_line" ] || return 0
  _value="${_line#*=}"
  case "$_value" in
    \"*\") _value="${_value#\"}" && _value="${_value%\"}" ;;
    \'*\') _value="${_value#\'}" && _value="${_value%\'}" ;;
  esac
  COMPANION_MEMORY_JSON="$_value"
  unset _env_file _line _value
}

# --- single-instance lock (non-blocking; a held lock is a clean skip) ---
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another deploy run holds the lock; skipping this tick"
  exit 0
fi

if [ ! -d "$DEPLOY_DIR/.git" ] && [ ! -f "$DEPLOY_DIR/.git" ]; then
  log "deploy dir $DEPLOY_DIR is not a git checkout; refusing"
  exit 1
fi
cd "$DEPLOY_DIR"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

git fetch origin
TARGET="$(git rev-parse origin/master)"
CURRENT="$(git rev-parse HEAD)"
if [ "$TARGET" = "$CURRENT" ]; then
  log "already at $CURRENT; nothing to do"
  exit 0
fi
log "candidate $CURRENT -> $TARGET"

# --- CI gate: target commit must be green. gh missing/unauthed => skip. ---
if ! command -v gh >/dev/null 2>&1; then
  log "gh not available; skipping deploy this tick (retry later)"
  exit 0
fi
if ! CHECK_RUNS_JSON="$(gh api "repos/${REPO_OWNER}/${REPO_NAME}/commits/${TARGET}/check-runs" --paginate 2>/dev/null)"; then
  log "gh api for check-runs failed (unauthed/offline?); skipping deploy this tick"
  exit 0
fi
CI_OK="$(CHECK_RUNS_JSON="$CHECK_RUNS_JSON" node --input-type=module -e '
const raw = process.env.CHECK_RUNS_JSON ?? "{}";
let doc;
try {
  doc = JSON.parse(raw);
} catch {
  process.stdout.write("parse-error");
  process.exit(0);
}
const runs = Array.isArray(doc.check_runs) ? doc.check_runs : [];
if (runs.length === 0) {
  process.stdout.write("no-checks");
  process.exit(0);
}
const bad = runs.filter(
  (r) => r.status !== "completed" || (r.conclusion !== "success" && r.conclusion !== "skipped"),
);
if (bad.length === 0) {
  process.stdout.write("green");
} else {
  process.stdout.write(`not-green:${bad.map((r) => `${r.name ?? "?"}:${r.status ?? "?"}/${r.conclusion ?? "?"}`).join(",")}`);
}
')"
case "$CI_OK" in
  green)
    log "CI green for $TARGET"
    ;;
  *)
    log "CI not green for $TARGET ($CI_OK); skipping deploy this tick"
    exit 0
    ;;
esac

# --- active-run gate: skip (retry next tick) while Companion is working ---
# The remind CLI is spawned per call, so an idle Companion means no remind
# child is reading dist/. This reuses the Companion deploy gate verbatim.
ACTIVE_JSON="$(node "$SCRIPT_DIR/activeRuns.mjs" 2>/dev/null || true)"
ACTIVE_N="$(CHECK_JSON="$ACTIVE_JSON" node --input-type=module -e '
try {
  process.stdout.write(String(JSON.parse(process.env.CHECK_JSON ?? "{}").active ?? "?"));
} catch {
  process.stdout.write("?");
}
')"
if [ "$ACTIVE_N" = "?" ]; then
  log "active-run check failed to report; skipping deploy this tick"
  exit 0
fi
if [ "$ACTIVE_N" != "0" ]; then
  log "$ACTIVE_N active run(s); skipping deploy this tick"
  exit 0
fi

# --- dirty-tree guard: never discard tracked modifications (untracked ignored) ---
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "deploy dir has tracked modifications; refusing (never discards). Clean the tree and retry."
  exit 1
fi

PREV="$CURRENT"
rollback() {
  log "rolling back to $PREV"
  git switch --detach "$PREV"
  npm ci
  npm run build
  log "rollback complete (previous revision restored and rebuilt)"
}

log "switching to $TARGET"
if ! { git switch --detach "$TARGET" && npm ci && npm run build; }; then
  log "switch/install/build failed for $TARGET; rolling back"
  rollback
  exit 1
fi

# --- smoke gate: one real record.list call must answer ok:true ---
# Invoke the same executable/entry/config/scope Companion uses when
# COMPANION_MEMORY_JSON is available; otherwise use the just-built CLI and
# the first allowedScope in the remind config (see remindDeploy.mjs). A
# missing scope is a config problem, so refuse instead of deploying unverified.
load_memory_json
MEMORY_JSON="${COMPANION_MEMORY_JSON:-}"
if ! SCOPE="$(node "$SCRIPT_DIR/remindDeploy.mjs" field scope \
  --memory-json "$MEMORY_JSON" \
  --config "$REMIND_CONFIG")" || [ -z "$SCOPE" ]; then
  log "cannot resolve a smoke-test scope from COMPANION_MEMORY_JSON or $REMIND_CONFIG; refusing"
  rollback
  exit 1
fi
if ! SMOKE_EXEC="$(node "$SCRIPT_DIR/remindDeploy.mjs" field executable \
  --memory-json "$MEMORY_JSON" --fallback "$(command -v node)")"; then
  log "cannot resolve the remind executable; refusing"
  rollback
  exit 1
fi
if ! SMOKE_ENTRY="$(node "$SCRIPT_DIR/remindDeploy.mjs" field entry \
  --memory-json "$MEMORY_JSON" --fallback "$DEPLOY_DIR/dist/src/cli.js")"; then
  log "cannot resolve the remind entry script; refusing"
  rollback
  exit 1
fi
if ! SMOKE_CONFIG="$(node "$SCRIPT_DIR/remindDeploy.mjs" field config \
  --memory-json "$MEMORY_JSON" --fallback "$REMIND_CONFIG")"; then
  log "cannot resolve the remind config path; refusing"
  rollback
  exit 1
fi
SMOKE_REQUEST="$(SCOPE="$SCOPE" node --input-type=module -e '
process.stdout.write(JSON.stringify({ v: 1, op: "record.list", params: { scope: process.env.SCOPE } }));
')"

SMOKE_FAILED=0
if ! SMOKE_OUT="$(printf '%s\n' "$SMOKE_REQUEST" |
  "$SMOKE_EXEC" "$SMOKE_ENTRY" --config "$SMOKE_CONFIG" 2>/dev/null)"; then
  SMOKE_FAILED=1
elif ! printf '%s\n' "$SMOKE_OUT" | node "$SCRIPT_DIR/remindDeploy.mjs" check-ok; then
  SMOKE_FAILED=1
fi
if [ "$SMOKE_FAILED" != "0" ]; then
  log "smoke test failed for $TARGET (record.list did not return ok:true); rolling back"
  rollback
  exit 1
fi

log "deployed $TARGET (smoke ok; no Companion restart needed)"
