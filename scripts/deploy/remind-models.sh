#!/bin/sh
# Copy the remind model directories to a stable location outside the
# remind checkout, so auto-deploy can move/replace ~/remind_master without
# invalidating vectors.modelDir / llm.modelDir in the running config.
#
# Usage: scripts/deploy/remind-models.sh [SOURCE_DIR]
#   Source: $1, else $REMIND_MODELS_SOURCE, else ~/remind/models.
#   Dest:   $REMIND_MODELS_DIR (default ~/.local/share/remind/models).
#
# `rsync -a` is idempotent (a re-run only copies differences) and never
# deletes extra files (no --delete). `--mkpath` creates the destination.
# This script does not edit the config; it prints the exact modelDir lines
# to update. The canonical way to (re)populate the model files is remind's
# own provisioning (network step):
#   npm run provision:model -- --dir <dest>/paraphrase-multilingual-MiniLM-L12-v2
#   npm run provision:llm   -- --dir <dest>/qwen25-15b-instruct
set -eu
umask 022

SOURCE="${1:-${REMIND_MODELS_SOURCE:-$HOME/remind/models}}"
DEST="${REMIND_MODELS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/remind/models}"
CONFIG="${REMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/remind/memory.config.json}"

log() {
  printf 'remind-models: %s\n' "$*"
}

fail() {
  printf 'remind-models: %s\n' "$*" >&2
  exit 1
}

command -v rsync >/dev/null 2>&1 || fail "rsync not found in PATH"
[ -d "$SOURCE" ] || fail "source model dir not found: $SOURCE"
[ -f "$CONFIG" ] || log "warning: config not found (will not be edited): $CONFIG"

log "syncing $SOURCE/ -> $DEST/"
rsync -a --mkpath -- "$SOURCE/" "$DEST/"

cat <<EOF

Stable model location: $DEST

Update only these lines in $CONFIG (keep the other vectors/llm fields):
  "vectors": { "modelDir": "$DEST/paraphrase-multilingual-MiniLM-L12-v2", ... }
  "llm":     { "modelDir": "$DEST/qwen25-15b-instruct", ... }

No Companion restart is needed: Companion passes the config path to a new
remind CLI process per call, and the CLI reads modelDir at startup.

Canonical (network) provisioning alternative, run in a remind checkout:
  npm run provision:model -- --dir "$DEST/paraphrase-multilingual-MiniLM-L12-v2"
  npm run provision:llm   -- --dir "$DEST/qwen25-15b-instruct"
EOF
