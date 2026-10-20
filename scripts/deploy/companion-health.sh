#!/bin/sh
# Local-only health monitor for the single Linux host. Run every 5 minutes
# by companion-health.timer. No external send: failures are written to the
# journal with `systemd-cat -p err` (plus ~/.local/state/companion/alerts.log
# via companion-alert@.service for unit failures).
#
# Checks:
#   - GET /health/live
#   - systemctl --user is-failed for companion/companion-deploy/companion-backup
#   - used space on / and /srv (error above 90% used)
#   - newest backup generation age for Companion and remind (error above 36h)
#
# Exit 0 when all checks pass, 1 when any check failed.

set -u

PORT="${COMPANION_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health/live"
BACKUP_ROOT="${COMPANION_BACKUP_ROOT:-$HOME/.local/share/companion-backups}"
MAX_BACKUP_AGE_H="${COMPANION_BACKUP_MAX_AGE_HOURS:-36}"
FAILURES=0

now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

report() {
  FAILURES=$((FAILURES + 1))
  if command -v systemd-cat >/dev/null 2>&1; then
    printf '%s companion-health: %s\n' "$(now)" "$*" |
      systemd-cat -p err -t companion-health
  else
    printf '%s companion-health: %s\n' "$(now)" "$*" >&2
  fi
}

# --- best-effort in-app notices (never affect the exit status) ---
# One error per distinct problem key while it persists; one info notice
# ("recovered") when a key clears. Dedupe state lives in
# ~/.local/state/companion/health-notify.json.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NOTIFY_SCRIPT="$SCRIPT_DIR/notify.sh"
STATE_SCRIPT="$SCRIPT_DIR/opsNotifyState.mjs"

report_problem() {
  key="$1"
  shift
  report "$*"
  # "error <episodeStartMs>" — the episode id scopes the fingerprint subject
  # so a re-occurrence after recovery is a fresh notice, not a dedup hit.
  verdict="$(node "$STATE_SCRIPT" health "$key" failing 2>/dev/null || true)"
  case "$verdict" in
    error*)
      episode="${verdict#error}"
      episode="${episode# }"
      "$NOTIFY_SCRIPT" error "ヘルスチェック失敗: $key" "$*" \
        "ops:health-fail:$key" "health:$key:$episode"
      ;;
  esac
}

report_recovered() {
  key="$1"
  verdict="$(node "$STATE_SCRIPT" health "$key" ok 2>/dev/null || true)"
  if [ "$verdict" = "recovered" ]; then
    "$NOTIFY_SCRIPT" info "ヘルスチェック回復: $key" "$key has recovered" \
      "ops:health-recovered:$key" "health:$key"
  fi
}

# --- liveness ---
if ! command -v curl >/dev/null 2>&1; then
  report_problem liveness "health_failed: curl_missing"
elif ! curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  report_problem liveness "health_failed: liveness_failed"
else
  report_recovered liveness
fi

# --- failed units ---
if command -v systemctl >/dev/null 2>&1; then
  # A previously recorded systemctl-missing failure must clear its key (and
  # emit the recovery notice) once systemctl is usable again.
  report_recovered systemctl
  for unit in companion.service companion-deploy.service companion-backup.service; do
    if systemctl --user is-failed --quiet "$unit" >/dev/null 2>&1; then
      report_problem "unit:$unit" "health_failed: unit_failed:$unit"
    else
      report_recovered "unit:$unit"
    fi
  done
else
  report_problem systemctl "health_failed: systemctl_missing"
fi

# --- disk used (df col5 is %used; error above 90% used) ---
# Bodies use fixed reason codes keyed by a fixed label — never the mount
# path (a filesystem path) or the df percentage (command output).
check_disk() {
  label="$1"
  mount="$2"
  used="$(df -P -k "$mount" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}')"
  case "$used" in
    ''|*[!0-9]*) report_problem "disk:$label" "health_failed: disk_check_failed:$label" ;;
    *)
      if [ "$used" -gt 90 ]; then
        report_problem "disk:$label" "health_failed: disk_low:$label"
      else
        report_recovered "disk:$label"
      fi
      ;;
  esac
}
check_disk root /
check_disk srv /srv

# --- backup age ---
check_backup_age() {
  dir="$1"
  label="$2"
  key="backup-age:$label"
  newest="$(find "$dir" -maxdepth 1 -type f -name '*.sqlite' \
    -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1)"
  if [ -z "$newest" ]; then
    report_problem "$key" "health_failed: no_backups:$label"
    return
  fi
  age_h="$(awk -v now="$(date +%s)" -v then="$newest" \
    'BEGIN { printf "%d", (now - then) / 3600 }')"
  if [ "$age_h" -gt "$MAX_BACKUP_AGE_H" ]; then
    report_problem "$key" "health_failed: backup_stale:$label"
  else
    report_recovered "$key"
  fi
}
check_backup_age "$BACKUP_ROOT/companion" companion
check_backup_age "$BACKUP_ROOT/remind" remind

if [ "$FAILURES" -gt 0 ]; then
  # A single journal line with the count keeps `journalctl -p err` readable.
  if command -v systemd-cat >/dev/null 2>&1; then
    printf '%s companion-health: %s check(s) failed\n' "$(now)" "$FAILURES" |
      systemd-cat -p err -t companion-health
  fi
  exit 1
fi

printf '%s companion-health: ok\n' "$(now)"
exit 0
