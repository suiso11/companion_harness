#!/bin/sh
# Daily backups for Companion + remind, run by companion-backup.timer.
#
# Companion: invokes the existing stopped-server CLI
#   (pnpm --filter @companion/server backup) inside the deploy dir, then
#   copies the verified result into ~/.local/share/companion-backups/companion
#   as an atomic generation.
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
DEPLOY_DIR="${COMPANION_DEPLOY_DIR:-$HOME/companion_master}"
BACKUP_ROOT="${COMPANION_BACKUP_ROOT:-$HOME/.local/share/companion-backups}"
KEEP="${COMPANION_BACKUP_KEEP:-7}"
REMIND_CONFIG="${REMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/remind/memory.config.json}"

log() {
  printf '%s companion-backup: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
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
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found in PATH"
KEEP="$(printf '%s' "$KEEP" | tr -cd '0-9')"
[ -n "$KEEP" ] && [ "$KEEP" -ge 1 ] 2>/dev/null || KEEP=7

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
COMPANION_DIR="$BACKUP_ROOT/companion"
REMIND_DIR="$BACKUP_ROOT/remind"
mkdir -p "$COMPANION_DIR" "$REMIND_DIR"
chmod 700 "$BACKUP_ROOT" "$COMPANION_DIR" "$REMIND_DIR" 2>/dev/null || true

prune_generations() {
  dir="$1"
  prefix="$2"
  protect="$3"
  count=0
  for name in $(find "$dir" -maxdepth 1 -type f -name "$prefix*.sqlite" \
    -printf '%T@ %f\n' 2>/dev/null | sort -rn | cut -d' ' -f2-); do
    count=$((count + 1))
    if [ "$count" -gt "$KEEP" ] && [ "$name" != "$protect" ]; then
      rm -f -- "$dir/$name"
      log "pruned $prefix$name"
    fi
  done
}

# --- Companion: existing backup CLI, then retain a local generation ---
log "running Companion backup in $DEPLOY_DIR"
BACKUP_OUTPUT="$(
  cd "$DEPLOY_DIR" &&
    pnpm --filter @companion/server backup 2>&1
)" || fail "Companion backup command failed"
NAME="$(printf '%s\n' "$BACKUP_OUTPUT" |
  awk '/^companion-manual-[^/\\]*\.sqlite$/{name=$0} END{print name}')"
[ -n "$NAME" ] || fail "Companion backup produced no backup name"

# activeRuns.mjs is also a CLI: its JSON reports the same default DB path
# the server uses (COMPANION_DB_PATH, else OS app-data). Its exit code is 2
# when runs are active, so ignore the status and validate the JSON instead.
DB_JSON="$(node "$SCRIPT_DIR/activeRuns.mjs" 2>/dev/null || true)"
[ -n "$DB_JSON" ] || fail "cannot resolve Companion DB directory"
DB_DIR="$(
  printf '%s' "$DB_JSON" | node --input-type=module -e '
import { dirname, resolve } from "node:path";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
process.stdout.write(dirname(resolve(JSON.parse(raw).db)));
' 2>/dev/null
)" || fail "cannot resolve Companion DB directory"
SRC="$DB_DIR/backups/$NAME"
[ -f "$SRC" ] || fail "Companion backup file missing after command"

DEST_NAME="companion-$STAMP-$$.sqlite"
DEST="$COMPANION_DIR/$DEST_NAME"
PARTIAL="$DEST.partial"
if ! cp -- "$SRC" "$PARTIAL"; then
  rm -f -- "$PARTIAL"
  fail "cannot copy Companion backup"
fi
chmod 600 "$PARTIAL" 2>/dev/null || true
if ! node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const row = db.prepare("PRAGMA quick_check").get();
db.close();
process.exit(row?.quick_check === "ok" ? 0 : 1);
' "$PARTIAL" >/dev/null 2>&1; then
  rm -f -- "$PARTIAL"
  fail "Companion backup copy failed quick_check"
fi
if ! mv -f -- "$PARTIAL" "$DEST"; then
  rm -f -- "$PARTIAL"
  fail "cannot publish Companion backup generation"
fi
log "stored Companion generation $DEST_NAME"
prune_generations "$COMPANION_DIR" "companion-" "$DEST_NAME"

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
  exit 1
}
log "stored remind generation $REMIND_OUT"

log "backup complete"
