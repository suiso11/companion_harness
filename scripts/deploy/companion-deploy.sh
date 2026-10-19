#!/bin/sh
# Polling auto-deploy for the single Linux host (user systemd, no inbound
# webhook — nothing is internet-exposed). Run by companion-deploy.timer.
#
# Policy: advance $COMPANION_DEPLOY_DIR (default ~/companion_master, a
# detached worktree) to origin/master ONLY when the target commit is green
# in CI and no run is active. Never discards local changes; rolls back to
# the previous sha when the new revision fails its health check.
#
# Logs go to stdout (journal). No secrets are printed.
# Single-instance via flock. Exit 0 = up-to-date or clean skip (retry next
# tick); exit 1 = refused (dirty tree) or failed (rollback attempted).
set -eu

DEPLOY_DIR="${COMPANION_DEPLOY_DIR:-$HOME/companion_master}"
PORT="${COMPANION_PORT:-3000}"
REPO_OWNER="${COMPANION_DEPLOY_REPO_OWNER:-suiso11}"
REPO_NAME="${COMPANION_DEPLOY_REPO_NAME:-companion_harness}"
HEALTH_URL="http://127.0.0.1:${PORT}/health/live"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/companion-deploy.lock"

log() {
  printf '%s companion-deploy: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
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

# --- active-run gate: skip (retry next tick) while work is in flight ---
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
  pnpm install --frozen-lockfile
  systemctl --user restart companion.service
  log "rollback complete (previous revision restored and restarted)"
}

log "switching to $TARGET"
git switch --detach "$TARGET"
pnpm install --frozen-lockfile
# NOTE: `pnpm start` runs the UI build via its prestart hook, so no
# separate build step is needed here.

if ! systemctl --user restart companion.service; then
  log "restart failed; rolling back"
  rollback
  exit 1
fi

# --- health gate: /health/live must answer within 60s, else roll back ---
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "deployed $TARGET (health ok)"
    exit 0
  fi
  sleep 2
  i=$((i + 1))
done

log "health check failed for $TARGET after 60s; rolling back"
rollback
exit 1
