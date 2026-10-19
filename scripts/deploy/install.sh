#!/bin/sh
# Install the Companion user-systemd units + env template on the Linux host.
# Copies units to ~/.config/systemd/user and creates ~/.config/companion/env
# (0600) with a no-secrets template when absent. Prints the commands the
# user must run. Starts/enables nothing unless --enable is passed.
#
# Usage: scripts/deploy/install.sh [--enable]
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/companion"
ENV_FILE="$ENV_DIR/env"
ENABLE=0

for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    -h|--help)
      printf 'usage: install.sh [--enable]\n'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$UNIT_DIR" "$ENV_DIR"
cp "$HERE/systemd/companion.service" "$UNIT_DIR/companion.service"
cp "$HERE/systemd/companion-deploy.service" "$UNIT_DIR/companion-deploy.service"
cp "$HERE/systemd/companion-deploy.timer" "$UNIT_DIR/companion-deploy.timer"
printf 'installed units to %s\n' "$UNIT_DIR"

if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
# Companion user-service environment (0600). No secrets are committed;
# fill in values on the host. All entries are KEY=VALUE lines.
# Secrets (OAuth client file path, tokens) stay as host paths / env only.
COMPANION_PORT=3000
COMPANION_DEPLOY_DIR=$HOME/companion_master
GOOGLE_ACCOUNT_MODE=normal
FORK_DIR=$HOME/gcal-readonly
# COMPANION_DB_PATH defaults to OS app-data when unset (recommended: leave unset).
# COMPANION_REMOTE_JSON stays unset (remote disabled) unless remote access is set up.
EOF
  chmod 600 "$ENV_FILE"
  printf 'created %s (0600) template — edit values on the host\n' "$ENV_FILE"
else
  printf '%s already exists — leaving untouched\n' "$ENV_FILE"
fi

# NOTE: %h in the unit files is expanded by systemd to the user's home.
cat <<'EOF'
Next steps (run on the host):
  systemctl --user daemon-reload
  systemctl --user enable --now companion.service companion-deploy.timer
  loginctl enable-linger $USER
Useful:
  systemctl --user stop companion-deploy.timer   # pause auto-deploy
  journalctl --user -u companion -u companion-deploy -f   # logs
EOF

if [ "$ENABLE" = "1" ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now companion.service companion-deploy.timer
  loginctl enable-linger "$USER"
fi
