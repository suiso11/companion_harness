#!/bin/sh
# Best-effort in-app ops notice writer. Wraps the server ops notify CLI
# (apps/server/src/ops_notify_cli.ts) with a hard 10s timeout, run from the
# deploy dir so the workspace toolchain resolves.
#
# Usage: notify.sh <info|error> <title> <body> <source> <subject>
#
# Never fails the caller: any problem (missing deploy dir, timeout, CLI
# error) is logged to stderr and the script exits 0. No external send:
# notices land only in the local in-app system feed.
set -u

DEPLOY_DIR="${COMPANION_DEPLOY_DIR:-$HOME/companion_master}"
ENV_FILE="${COMPANION_ENV_FILE:-$HOME/.config/companion/env}"

log() {
  printf '%s ops-notify: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

if [ "$#" -ne 5 ]; then
  log "usage: notify.sh <info|error> <title> <body> <source> <subject>"
  exit 0
fi
LEVEL="$1"
TITLE="$2"
BODY="$3"
SOURCE="$4"
SUBJECT="$5"

if [ ! -d "$DEPLOY_DIR" ]; then
  log "deploy dir not found: $DEPLOY_DIR"
  exit 0
fi
if ! cd "$DEPLOY_DIR"; then
  log "cannot enter deploy dir: $DEPLOY_DIR"
  exit 0
fi
# Under systemd the unit's EnvironmentFile already provides COMPANION_DB_PATH;
# best-effort fallback for manual runs. NOTE: never `. "$ENV_FILE"` the whole
# file — shell sourcing applies sh quoting rules, which mangle the quoted
# JSON values (COMPANION_MEMORY_JSON / COMPANION_REMOTE_JSON) that systemd's
# EnvironmentFile parser already unescaped correctly, and the mangled values
# clobber the good env, making loadServerConfig fail with invalid
# configuration (live bug 2026-10-20: every success notify failed this way).
# Extract ONLY the DB path, without evaluating any other line.
if [ -z "${COMPANION_DB_PATH:-}" ] && [ -f "$ENV_FILE" ]; then
  _db_line="$(grep -E '^COMPANION_DB_PATH=' "$ENV_FILE" | tail -1 || true)"
  COMPANION_DB_PATH="${_db_line#COMPANION_DB_PATH=}"
  # Strip one pair of surrounding double or single quotes if present.
  case "$COMPANION_DB_PATH" in
    "\"\"") COMPANION_DB_PATH="" ;;
    \"*\") COMPANION_DB_PATH="$(printf '%s' "$COMPANION_DB_PATH" | sed -e 's/^"//' -e 's/"$//')" ;;
    \'*\') COMPANION_DB_PATH="$(printf '%s' "$COMPANION_DB_PATH" | sed -e "s/^'//" -e "s/'\$//")" ;;
  esac
  export COMPANION_DB_PATH
  unset _db_line
fi

NOTIFY_OUT="$(timeout 10 pnpm --filter @companion/server exec tsx \
  src/ops_notify_cli.ts notify \
  --level "$LEVEL" --title "$TITLE" --body "$BODY" \
  --source "$SOURCE" --subject "$SUBJECT" 2>&1)"
NOTIFY_STATUS=$?
if [ "$NOTIFY_STATUS" -ne 0 ]; then
  log "notify failed (status $NOTIFY_STATUS): $NOTIFY_OUT"
fi
exit 0
