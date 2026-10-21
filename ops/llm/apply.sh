#!/bin/sh
# Apply the repo's LLM stack files to /srv/llm and reconcile the containers.
#
# Shows a unified diff first. Without --yes it never writes files and never
# reconciles containers: it only shows the diff (diff-only, even when the
# files already match). On a TTY it asks for confirmation before writing;
# non-interactive runs must pass --yes. Only compose.yaml,
# litellm_config.yaml and searxng/settings.yml are copied; /srv/llm/.env is
# never read, copied, or printed (the SearXNG secret is only ever appended to
# it — see below). The compose invocation inherits the host's existing .env.
#
# SearXNG (docs/plan/web_search_design.md): searxng/settings.yml is validated
# as YAML (when a parser is available) and copied into /srv/llm/searxng/.
# With --yes, if /srv/llm/.env has no SEARXNG_SECRET line, one is generated
# (openssl rand -hex 32) and appended atomically; the value is never printed.
# The searxng container is force-recreated when settings.yml (which is a
# read-only bind mount) changes.
#
# When litellm_config.yaml changes, the litellm container is force-recreated
# because the file is a bind mount: the atomic rename below swaps the inode,
# so a plain `up -d` would keep the old config live inside the container.
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
SEARXNG_SRC="$SCRIPT_DIR/searxng/settings.yml"
[ -f "$SEARXNG_SRC" ] || {
  printf 'apply: missing %s\n' "$SEARXNG_SRC" >&2
  exit 1
}
[ -d "$DEST" ] || {
  printf 'apply: destination %s does not exist\n' "$DEST" >&2
  exit 1
}

# Validate searxng/settings.yml as YAML before showing any diff. Uses
# python3 + PyYAML when available; the host may legitimately lack one, in
# which case a parse-check warning is emitted instead of failing the apply.
if command -v python3 >/dev/null 2>&1 && \
   python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' \
    "$SEARXNG_SRC" || {
    printf 'apply: searxng/settings.yml is not valid YAML\n' >&2
    exit 1
  }
  python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' \
    "$SCRIPT_DIR/compose.yaml" || {
    printf 'apply: compose.yaml is not valid YAML\n' >&2
    exit 1
  }
else
  printf 'apply: warning: python3/PyYAML not found; skipping YAML validation of settings.yml/compose.yaml\n' >&2
fi

if [ ! -f "$DEST/.env" ]; then
  printf 'apply: %s/.env is missing; copy .env.example there and fill it first\n' "$DEST" >&2
  exit 1
fi

CHANGED=0
LITELLM_CHANGED=0
SEARXNG_CHANGED=0

# ensure_secret <dest-env> — guarantees a SEARXNG_SECRET line exists.
# Generates one with openssl if missing; never echoes the value.
ensure_secret() {
  env_file="$1"
  if [ "$(grep -c '^SEARXNG_SECRET=' "$env_file" || true)" -gt 1 ]; then
    printf 'apply: %s has multiple SEARXNG_SECRET lines; refusing\n' "$env_file" >&2
    exit 1
  fi
  if grep -q '^SEARXNG_SECRET=[^[:space:]]' "$env_file"; then
    return 0
  fi
  [ "$(command -v openssl)" ] || {
    printf 'apply: openssl not found; cannot generate SEARXNG_SECRET\n' >&2
    exit 1
  }
  new_secret="$(openssl rand -hex 32)"
  # Append to a temp copy and rename atomically; the value is never printed.
  tmp="$env_file.apply.$$"
  umask_u00="$(umask)"
  umask 077
  {
    cat "$env_file"
    printf 'SEARXNG_SECRET=%s\n' "$new_secret"
  } >"$tmp"
  chmod 600 "$tmp"
  umask "$umask_u00"
  mv -f "$tmp" "$env_file"
  printf 'apply: generated SEARXNG_SECRET in %s\n' "$env_file"
}

for name in compose.yaml litellm_config.yaml; do
  if [ -f "$DEST/$name" ] && cmp -s "$SCRIPT_DIR/$name" "$DEST/$name"; then
    printf 'apply: %s is already up to date\n' "$name"
    continue
  fi
  CHANGED=1
  [ "$name" = "litellm_config.yaml" ] && LITELLM_CHANGED=1
  printf '\n--- diff %s ---\n' "$name"
  if [ -f "$DEST/$name" ]; then
    diff -u "$DEST/$name" "$SCRIPT_DIR/$name" || true
  else
    diff -u /dev/null "$SCRIPT_DIR/$name" || true
  fi
done

# searxng dir: the deployed layout is $DEST/searxng/settings.yml.
SEARXNG_DEST="$DEST/searxng"
searxng_up_to_date() {
  [ -f "$SEARXNG_DEST/settings.yml" ] &&
    cmp -s "$SEARXNG_SRC" "$SEARXNG_DEST/settings.yml"
}
if searxng_up_to_date; then
  printf 'apply: searxng/settings.yml is already up to date\n'
else
  CHANGED=1
  SEARXNG_CHANGED=1
  printf '\n--- diff searxng/settings.yml ---\n'
  if [ -f "$SEARXNG_DEST/settings.yml" ]; then
    diff -u "$SEARXNG_DEST/settings.yml" "$SEARXNG_SRC" || true
  else
    diff -u /dev/null "$SEARXNG_SRC" || true
  fi
fi

if [ "$CHANGED" -eq 0 ]; then
  printf 'apply: repo files match %s\n' "$DEST"
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf 'apply: diff-only run; pass --yes to reconcile containers\n'
    exit 0
  fi
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

  # searxng dir: build a fresh temp dir, rename it atomically into place
  # (the swap between the two mv's is the existing-dir case; each rename
  # itself is atomic).
  if [ "$SEARXNG_CHANGED" -eq 1 ]; then
    tmp_dir="$DEST/.searxng.tmp.$$"
    rm -rf "$tmp_dir"
    mkdir -m 755 "$tmp_dir"
    cp "$SEARXNG_SRC" "$tmp_dir/settings.yml"
    chmod 644 "$tmp_dir/settings.yml"
    if [ -d "$SEARXNG_DEST" ]; then
      old_dir="$DEST/.searxng.old.$$"
      mv "$SEARXNG_DEST" "$old_dir"
      mv "$tmp_dir" "$SEARXNG_DEST"
      rm -rf "$old_dir"
    else
      mv "$tmp_dir" "$SEARXNG_DEST"
    fi
    printf 'apply: wrote %s/settings.yml\n' "$SEARXNG_DEST"
  fi

  # SearXNG needs its secret in .env before the container interpolates it.
  ensure_secret "$DEST/.env"
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'apply: docker not found\n' >&2
  exit 1
fi

RECRATE_SERVICES=""
[ "$LITELLM_CHANGED" -eq 1 ] && RECREATE_SERVICES="litellm"
[ "$SEARXNG_CHANGED" -eq 1 ] && RECREATE_SERVICES="$RECREATE_SERVICES searxng"

# litellm_config.yaml / searxng/settings.yml are bind-mounted; the atomic
# renames above swap the inodes, so only --force-recreate makes the
# containers see the new files.
if [ -n "$RECREATE_SERVICES" ]; then
  # shellcheck disable=SC2086
  docker compose --project-directory "$DEST" --env-file "$DEST/.env" \
    -f "$DEST/compose.yaml" up -d --remove-orphans --force-recreate $RECREATE_SERVICES
else
  docker compose --project-directory "$DEST" --env-file "$DEST/.env" \
    -f "$DEST/compose.yaml" up -d --remove-orphans
fi
printf 'apply: containers reconciled (litellm on :4000, gemma internal :8080, searxng on 127.0.0.1:8888)\n'
