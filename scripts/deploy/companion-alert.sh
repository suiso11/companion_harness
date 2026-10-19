#!/bin/sh
# Local failure alert hook for companion-alert@.service.
# Invoked by systemd as: companion-alert.sh <failed-unit>
#
# Appends one line to ~/.local/state/companion/alerts.log (0700 dir,
# 0600 file) and logs the same line to the journal at err priority.
# No external send: push/email alerting is intentionally out of scope.

set -eu

UNIT="${1:-unknown-unit}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/companion"
LOG_FILE="$STATE_DIR/alerts.log"
STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
LINE="$STAMP unit=$UNIT failed"

umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
printf '%s\n' "$LINE" >>"$LOG_FILE"
chmod 600 "$LOG_FILE" 2>/dev/null || true

if command -v systemd-cat >/dev/null 2>&1; then
  printf '%s companion-alert: %s\n' "$STAMP" "$LINE" |
    systemd-cat -p err -t companion-alert
else
  printf '%s companion-alert: %s\n' "$STAMP" "$LINE" >&2
fi
