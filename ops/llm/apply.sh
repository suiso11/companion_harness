#!/bin/sh
# Apply the repo's LLM stack files to /srv/llm and reconcile the containers.
#
# Shows a unified diff first. Without --yes it asks for confirmation on a
# TTY (non-interactive runs must pass --yes). Only compose.yaml and
# litellm_config.yaml are copied; /srv/llm/.env is never read, copied, or
# printed. The compose invocation inherits the host's existing .env.
#
# Usage: ops/llm/apply.sh [--yes] [--dest /srv/llm]

set -eu
umask 022

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEST="${LLM_DIR:-/srv/llm}"
ASSUME_YES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --dest=*) DEST="${1#--dest=}" ;;
    --dest)
      [ "$#" -ge 2 ] || {
        printf 'apply: --dest needs a value\n' >&2
        exit 2
      }
      DEST="$2"
      shift
      ;;
    -h|--help)
      printf 'usage: apply.sh [--yes] [--dest DIR]\n'
      exit 0
      ;;
    *)
      printf 'apply: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

[ -f "$SCRIPT_DIR/compose.yaml" ] || {
  printf 'apply: missing %s/compose.yaml\n' "$SCRIPT_DIR" >&2
  exit 1
}
[ -f "$SCRIPT_DIR/litellm_config.yaml" ] || {
  printf 'apply: missing %s/litellm_config.yaml\n' "$SCRIPT_DIR" >&2
  exit 1
}
[ -d "$DEST" ] || {
  printf 'apply: destination %s does not exist\n' "$DEST" >&2
  exit 1
}

if [ ! -f "$DEST/.env" ]; then
  printf 'apply: %s/.env is missing; copy .env.example there and fill it first\n' "$DEST" >&2
  exit 1
fi

CHANGED=0
for name in compose.yaml litellm_config.yaml; do
  if [ -f "$DEST/$name" ] && cmp -s "$SCRIPT_DIR/$name" "$DEST/$name"; then
    printf 'apply: %s is already up to date\n' "$name"
    continue
  fi
  CHANGED=1
  printf '\n--- diff %s ---\n' "$name"
  if [ -f "$DEST/$name" ]; then
    diff -u "$DEST/$name" "$SCRIPT_DIR/$name" || true
  else
    diff -u /dev/null "$SCRIPT_DIR/$name" || true
  fi
done

if [ "$CHANGED" -eq 0 ]; then
  printf 'apply: repo files match %s; reconciling containers\n' "$DEST"
else
  if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
      printf 'apply: differences found; re-run with --yes (non-interactive)\n' >&2
      exit 1
    fi
    printf '\nCopy these files to %s? [y/N] ' "$DEST"
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *)
        printf 'apply: aborted; %s unchanged\n' "$DEST"
        exit 1
        ;;
    esac
  fi
  for name in compose.yaml litellm_config.yaml; do
    if [ -f "$DEST/$name" ] && cmp -s "$SCRIPT_DIR/$name" "$DEST/$name"; then
      continue
    fi
    tmp="$DEST/.$name.tmp.$$"
    cp "$SCRIPT_DIR/$name" "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$DEST/$name"
    printf 'apply: wrote %s\n' "$DEST/$name"
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'apply: docker not found\n' >&2
  exit 1
fi

docker compose --project-directory "$DEST" --env-file "$DEST/.env" \
  -f "$DEST/compose.yaml" up -d
printf 'apply: containers reconciled (litellm on :4000, gemma internal :8080)\n'
