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

# Best-effort in-app notices (never fails the deploy script).
NOTIFY_SCRIPT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/notify.sh"
STATE_SCRIPT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/opsNotifyState.mjs"

notify_skip_persisted() {
  # One info notice per target per hour window while the skip persists.
  # The reason (e.g. the not-green check list) is bounded to 200 code
  # points so the body stays within the notify CLI's 300-cp limit even when
  # many checks are pending/failed, and the hour window is part of the
  # fingerprint subject so each window gets its own notice.
  target="$1"
  reason="$2"
  reason="$(node -e 'process.stdout.write(Array.from(process.argv[1] ?? "").slice(0, 200).join(""))' "$reason" 2>/dev/null || printf '%s' "$reason")"
  if [ "$(node "$STATE_SCRIPT" skip "$target" 2>/dev/null || true)" = "notify" ]; then
    short="$(git rev-parse --short "$target" 2>/dev/null || echo "$target")"
    hour="$(date -u '+%Y%m%dT%H')"
    "$NOTIFY_SCRIPT" info \
      "デプロイスキップ継続" \
      "target ${short} has been skipped for over 1h (${reason})" \
      "ops:deploy-skip:${short}" \
      "deploy-skip:${target}:${hour}"
  fi
}

notify_success() {
  # デプロイ完了 <short sha> (<#PR from merge commit subject>)
  target="$1"
  short="$(git rev-parse --short "$target" 2>/dev/null || echo "$target")"
  subject="$(git log -1 --format=%s "$target" 2>/dev/null || true)"
  pr="$(printf '%s' "$subject" | sed -n 's/.*pull request #\([0-9][0-9]*\).*/#\1/p')"
  title="デプロイ完了 ${short}"
  body="deployed ${short} (health ok)"
  if [ -n "$pr" ]; then
    title="デプロイ完了 ${short} (${pr})"
    body="deployed ${short} (${pr}) (health ok)"
  fi
  node "$STATE_SCRIPT" skip-clear "$target" >/dev/null 2>&1 || true
  "$NOTIFY_SCRIPT" info "$title" "$body" "ops:deploy:${short}" "deploy-success:${target}"
}

notify_rollback() {
  target="$1"
  reason="$2"
  short="$(git rev-parse --short "$target" 2>/dev/null || echo "$target")"
  "$NOTIFY_SCRIPT" error \
    "デプロイ失敗（ロールバック）" \
    "deploy of ${short} failed (${reason}); rolled back to previous revision" \
    "ops:deploy-fail:${short}" \
    "deploy-rollback:${target}"
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
    notify_skip_persisted "$TARGET" "CI not green: $CI_OK"
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
  notify_skip_persisted "$TARGET" "$ACTIVE_N active run(s)"
  exit 0
fi

# --- dirty-tree guard: never discard tracked modifications (untracked ignored) ---
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "deploy dir has tracked modifications; refusing (never discards). Clean the tree and retry."
  exit 1
fi

PREV="$CURRENT"
# Trial profile paths/backups are filled in just before the rebuild below.
TRIAL_OPERATOR_INPUT="${COMPANION_TRIAL_OPERATOR_INPUT:-$HOME/.config/companion/trial-operator.json}"
TRIAL_OPERATOR_FILE=""
TRIAL_ENV_FILE=""
TRIAL_BACKUP_DIR=""
rollback() {
  log "rolling back to $PREV"
  git switch --detach "$PREV"
  pnpm install --frozen-lockfile
  # The new revision's trial profile may already be published; restore the
  # pre-deploy operator.json/autonomy.env pair before restarting the old app so
  # trials never run against the rejected revision.
  if [ -n "$TRIAL_BACKUP_DIR" ]; then
    if [ -f "$TRIAL_BACKUP_DIR/operator.json" ]; then
      cp -p "$TRIAL_BACKUP_DIR/operator.json" "$TRIAL_OPERATOR_FILE"
    else
      rm -f "$TRIAL_OPERATOR_FILE"
    fi
    if [ -f "$TRIAL_BACKUP_DIR/autonomy.env" ]; then
      cp -p "$TRIAL_BACKUP_DIR/autonomy.env" "$TRIAL_ENV_FILE"
    else
      rm -f "$TRIAL_ENV_FILE"
    fi
    rm -rf "$TRIAL_BACKUP_DIR"
    TRIAL_BACKUP_DIR=""
    log "restored the previous trial operator profile before rollback restart"
  fi
  systemctl --user restart companion.service
  log "rollback complete (previous revision restored and restarted)"
  notify_rollback "$TARGET" "health check or restart failed"
}

log "switching to $TARGET"
git switch --detach "$TARGET"
pnpm install --frozen-lockfile

# --- frozen trial operator: rebuild from the deployed sha, then restart ---
# The builder exports a clean archive of HEAD, verifies the materialized
# snapshot, and only then atomically switches operator.json + autonomy.env.
# A failure must NOT block app deploys, but it must fail CLOSED: a retained
# profile can still match the restarted server, so replace autonomy.env with
# an empty file (no COMPANION_AUTONOMY_JSON line) before the restart.
if [ -f "$TRIAL_OPERATOR_INPUT" ]; then
  TRIAL_OPERATOR_FILE="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.operatorFile ?? "")' "$TRIAL_OPERATOR_INPUT" 2>/dev/null || true)"
  TRIAL_ENV_FILE="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.environmentFile ?? "")' "$TRIAL_OPERATOR_INPUT" 2>/dev/null || true)"
fi
if [ -n "$TRIAL_OPERATOR_FILE" ] && [ -n "$TRIAL_ENV_FILE" ]; then
  TRIAL_BACKUP_DIR="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/companion-trial-backup.XXXXXX" 2>/dev/null || true)"
  if [ -n "$TRIAL_BACKUP_DIR" ]; then
    if [ -f "$TRIAL_OPERATOR_FILE" ]; then
      cp -p "$TRIAL_OPERATOR_FILE" "$TRIAL_BACKUP_DIR/operator.json"
    fi
    if [ -f "$TRIAL_ENV_FILE" ]; then
      cp -p "$TRIAL_ENV_FILE" "$TRIAL_BACKUP_DIR/autonomy.env"
    fi
  else
    log "WARNING could not create a trial profile backup; a rollback cannot restore it"
  fi
fi
if [ -f "$TRIAL_OPERATOR_INPUT" ]; then
  log "rebuilding frozen trial operator for $TARGET"
  BUILD_OK=1
  if [ -n "$TRIAL_BACKUP_DIR" ]; then
    COMPANION_TRIAL_OPERATOR_INPUT="$TRIAL_OPERATOR_INPUT" \
      COMPANION_TRIAL_ROLLBACK_OPERATOR_FILE="$TRIAL_BACKUP_DIR/operator.json" \
      pnpm --filter @companion/server exec tsx "$SCRIPT_DIR/build-trial-operator.mts" || BUILD_OK=0
  else
    COMPANION_TRIAL_OPERATOR_INPUT="$TRIAL_OPERATOR_INPUT" \
      pnpm --filter @companion/server exec tsx "$SCRIPT_DIR/build-trial-operator.mts" || BUILD_OK=0
  fi
  if [ "$BUILD_OK" != "1" ]; then
    log "ERROR trial operator rebuild FAILED for $TARGET; disabling trials before restart (fail closed)"
    # Keep the previous config but force `enabled:false`: an EMPTY file would
    # break startup on hosts that also set COMPANION_AUTODISPATCH_JSON, since
    # the server rejects autodispatch without a trial config. If no usable
    # previous config exists, fall back to an empty file, but roll back rather
    # than restart unstartable when autodispatch is configured.
    DISABLED_ENV_LINE="$(node "$SCRIPT_DIR/disable-trial-env.mjs" "$TRIAL_ENV_FILE" 2>/dev/null || true)"
    if [ -z "$DISABLED_ENV_LINE" ] && [ -n "${COMPANION_AUTODISPATCH_JSON:-}" ]; then
      log "ERROR no usable prior trial config to keep disabled; rolling back instead of restarting with autodispatch but no trial config"
      rollback
      exit 1
    fi
    TRIAL_ENV_TMP="${TRIAL_ENV_FILE}.tmp-$$"
    if mkdir -p "$(dirname "$TRIAL_ENV_FILE")" \
      && printf '%s\n' "$DISABLED_ENV_LINE" > "$TRIAL_ENV_TMP" \
      && chmod 600 "$TRIAL_ENV_TMP" \
      && mv -f "$TRIAL_ENV_TMP" "$TRIAL_ENV_FILE"; then
      log "autonomy.env reset (trials disabled) before restart"
    else
      rm -f "$TRIAL_ENV_TMP"
      log "ERROR could not disable trials; rolling back instead of restarting with a stale profile"
      rollback
      exit 1
    fi
  fi
else
  log "trial operator input missing ($TRIAL_OPERATOR_INPUT); skipping trial rebuild"
fi

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
    # Server has restarted and is healthy: DB writes are safe now, so
    # notices are written only after health is ok.
    notify_success "$TARGET"
    if [ -n "$TRIAL_BACKUP_DIR" ]; then
      rm -rf "$TRIAL_BACKUP_DIR"
      TRIAL_BACKUP_DIR=""
    fi
    exit 0
  fi
  sleep 2
  i=$((i + 1))
done

log "health check failed for $TARGET after 60s; rolling back"
rollback
exit 1
