#!/bin/sh
# Daily backups for Companion + remind, run by companion-backup.timer.
#
# Companion: the timer may fire while companion.service is running, and the
#   backup CLI contract is stopped-server only, so scripts/deploy/
#   companion-online-backup.mjs instead opens the live DB read-only and uses
#   node:sqlite's online backup API (no downtime), verifies
#   PRAGMA integrity_check, publishes an atomic generation in
#   ~/.local/share/companion-backups/companion, and prunes both old
#   generations and the legacy CLI-written companion-manual-*.sqlite files
#   in the DB's own <data>/backups dir (newest N kept either way).
# remind: no CLI backup command exists, so scripts/deploy/remind-backup.mjs
#   uses node:sqlite's online backup API against the read-only DB path
#   resolved from ~/.config/remind/memory.config.json.
#
# Both stores keep the newest N=7 generations (0700 dirs, 0600 files).
# Old generations are pruned only AFTER a new copy verified and renamed,
# so a failed run never removes the newest good copy.
#
# Logs go to stdout (journal). No secrets/paths beyond generation names.

set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_ROOT="${COMPANION_BACKUP_ROOT:-$HOME/.local/share/companion-backups}"
KEEP="${COMPANION_BACKUP_KEEP:-7}"
REMIND_CONFIG="${REMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/remind/memory.config.json}"

log() {
  printf '%s companion-backup: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# Best-effort in-app failure notice (never changes the exit path).
notify_fail() {
  label="$1"
  detail="$2"
  # The run timestamp scopes the fingerprint so a later failing episode for
  # the same label is not kernel-deduped against the first one forever.
  "$SCRIPT_DIR/notify.sh" error \
    "バックアップ失敗" \
    "$detail" \
    "ops:backup-fail:$label" \
    "backup-fail:$label:$(date -u '+%Y%m%dT%H%M%SZ')"
}

fail() {
  log "$*"
  exit 1
}

# Single-instance lock: a held lock means another backup is still running.
LOCK_DIR="${XDG_RUNTIME_DIR:-/tmp}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_DIR/companion-backup.lock"
  if ! flock -n 9; then
    log "another backup run holds the lock; skipping this tick"
    exit 0
  fi
fi

command -v node >/dev/null 2>&1 || fail "node not found in PATH"
KEEP="$(printf '%s' "$KEEP" | tr -cd '0-9')"
[ -n "$KEEP" ] && [ "$KEEP" -ge 1 ] 2>/dev/null || KEEP=7

COMPANION_DIR="$BACKUP_ROOT/companion"
REMIND_DIR="$BACKUP_ROOT/remind"
mkdir -p "$COMPANION_DIR" "$REMIND_DIR"
chmod 700 "$BACKUP_ROOT" "$COMPANION_DIR" "$REMIND_DIR" 2>/dev/null || true

# --- Companion: online backup of the live DB (read-only, no downtime) ---
# The old stopped-server CLI is no longer invoked: the timer can fire while
# companion.service is running and that CLI contract requires a stopped
# server. The online backup needs no stop/restart and verifies integrity.
COMPANION_OUT="$(
  node "$SCRIPT_DIR/companion-online-backup.mjs" \
    --out-dir "$COMPANION_DIR" \
    --keep "$KEEP"
)" || {
  log "Companion backup failed"
  printf '%s\n' "$COMPANION_OUT" >&2
  notify_fail companion "Companion online backup failed"
  exit 1
}
log "stored Companion generation $COMPANION_OUT"

# --- remind: online backup of the configured DB ---
log "running remind backup from configured dbPath"
REMIND_OUT="$(
  node "$SCRIPT_DIR/remind-backup.mjs" \
    --config "$REMIND_CONFIG" \
    --out-dir "$REMIND_DIR" \
    --keep "$KEEP"
)" || {
  log "remind backup failed"
  printf '%s\n' "$REMIND_OUT" >&2
  notify_fail remind "remind online backup failed"
  exit 1
}
log "stored remind generation $REMIND_OUT"

log "backup complete"
