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

# systemd user services do not inherit the login-shell PATH, so bare
# `node`/`pnpm` in run-google-readonly.sh / companion-deploy.sh fail with
# `node: not found` (exit 127) when node lives in ~/.local/bin. Resolve
# both at install time and pin them into per-unit drop-ins; the unit files
# in the repo stay generic.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  printf 'install.sh: node not found in PATH (systemd user units get no login-shell PATH; install Node 24, e.g. ~/.local/bin, then re-run)\n' >&2
  exit 1
fi
PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
if [ -z "$PNPM_BIN" ]; then
  printf 'install.sh: pnpm not found in PATH (systemd user units get no login-shell PATH; install pnpm, e.g. ~/.local/bin, then re-run)\n' >&2
  exit 1
fi
NODE_DIR="$(dirname -- "$NODE_BIN")"
PNPM_DIR="$(dirname -- "$PNPM_BIN")"
UNIT_PATH="$NODE_DIR:$PNPM_DIR:/usr/local/bin:/usr/bin:/bin"
DEDUP=""
OLD_IFS="$IFS"
IFS=":"
for _d in $UNIT_PATH; do
  case ":$DEDUP:" in
    *":$_d:"*) ;;
    *) DEDUP="${DEDUP:+$DEDUP:}$_d" ;;
  esac
done
IFS="$OLD_IFS"
UNIT_PATH="$DEDUP"
unset DEDUP OLD_IFS _d NODE_BIN PNPM_BIN NODE_DIR PNPM_DIR

cp "$HERE/systemd/companion.service" "$UNIT_DIR/companion.service"
cp "$HERE/systemd/companion-deploy.service" "$UNIT_DIR/companion-deploy.service"
cp "$HERE/systemd/companion-deploy.timer" "$UNIT_DIR/companion-deploy.timer"
printf 'installed units to %s\n' "$UNIT_DIR"

# companion-deploy.sh needs git, gh, pnpm, node: the same pinned PATH
# covers both units (git/gh normally live in /usr/bin already in the
# fallback tail).
for _svc in companion.service companion-deploy.service; do
  mkdir -p "$UNIT_DIR/$_svc.d"
  printf '[Service]\nEnvironment=PATH=%s\n' "$UNIT_PATH" >"$UNIT_DIR/$_svc.d/path.conf"
  printf 'wrote %s\n' "$UNIT_DIR/$_svc.d/path.conf"
done
unset _svc
printf 'pinned unit PATH=%s\n' "$UNIT_PATH"
unset UNIT_PATH

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
