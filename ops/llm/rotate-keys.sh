#!/bin/sh
# Rotate the local LLM stack keys without printing them.
#
# 1. Generate a new LLAMA_API_KEY and LITELLM_MASTER_KEY (openssl rand -hex 32).
# 2. Back up /srv/llm/.env to .env.bak-<UTC> (0600) and write the new values
#    atomically (0600).
# 3. Update LITELLM_MASTER_KEY in the Companion env file (default
#    ~/companion_master/.env.litellm, 0600; path overridable) and back it up.
# 4. Recreate gemma + litellm, restart companion.service, then verify an
#    authenticated LiteLLM /v1/models call.
#
# Keys are never echoed. Requires --yes (write action).
#
# Usage:
#   ops/llm/rotate-keys.sh --yes [--llm-dir DIR] [--companion-env FILE]
#                                [--url http://127.0.0.1:4000]

set -eu
umask 077

ASSUME_YES=0
LLM_DIR="${LLM_DIR:-/srv/llm}"
COMPANION_ENV="${COMPANION_ENV:-$HOME/companion_master/.env.litellm}"
BASE_URL="${LITELLM_URL:-http://127.0.0.1:4000}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --llm-dir=*) LLM_DIR="${1#--llm-dir=}" ;;
    --llm-dir)
      [ "$#" -ge 2 ] || {
        printf 'rotate-keys: --llm-dir needs a value\n' >&2
        exit 2
      }
      LLM_DIR="$2"
      shift
      ;;
    --companion-env=*) COMPANION_ENV="${1#--companion-env=}" ;;
    --companion-env)
      [ "$#" -ge 2 ] || {
        printf 'rotate-keys: --companion-env needs a value\n' >&2
        exit 2
      }
      COMPANION_ENV="$2"
      shift
      ;;
    --url=*) BASE_URL="${1#--url=}" ;;
    --url)
      [ "$#" -ge 2 ] || {
        printf 'rotate-keys: --url needs a value\n' >&2
        exit 2
      }
      BASE_URL="$2"
      shift
      ;;
    -h|--help)
      printf 'usage: rotate-keys.sh --yes [--llm-dir DIR] [--companion-env FILE] [--url URL]\n'
      exit 0
      ;;
    *)
      printf 'rotate-keys: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'rotate-keys: this rewrites %s/.env and %s and restarts services.\n' \
    "$LLM_DIR" "$COMPANION_ENV" >&2
  printf 'rotate-keys: re-run with --yes to proceed.\n' >&2
  exit 2
fi

# Validate BOTH destinations before touching either file: if the Companion
# env directory is missing or unwritable, abort before /srv/llm/.env is
# rewritten, or the containers would end up with mismatched keys.
ENV_FILE="$LLM_DIR/.env"
COMPOSE_FILE="$LLM_DIR/compose.yaml"
COMPANION_DIR="$(dirname -- "$COMPANION_ENV")"
[ -f "$ENV_FILE" ] || {
  printf 'rotate-keys: %s is missing\n' "$ENV_FILE" >&2
  exit 1
}
[ -f "$COMPOSE_FILE" ] || {
  printf 'rotate-keys: %s is missing\n' "$COMPOSE_FILE" >&2
  exit 1
}
[ -d "$COMPANION_DIR" ] || {
  printf 'rotate-keys: companion env directory %s is missing\n' "$COMPANION_DIR" >&2
  exit 1
}
[ -w "$COMPANION_DIR" ] || {
  printf 'rotate-keys: companion env directory %s is not writable\n' "$COMPANION_DIR" >&2
  exit 1
}
if [ -f "$COMPANION_ENV" ] && [ ! -w "$COMPANION_ENV" ]; then
  printf 'rotate-keys: companion env file %s is not writable\n' "$COMPANION_ENV" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  printf 'rotate-keys: openssl not found\n' >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'rotate-keys: docker not found\n' >&2
  exit 1
}

NEW_LLAMA="$(openssl rand -hex 32)"
NEW_MASTER="$(openssl rand -hex 32)"
for key in "$NEW_LLAMA" "$NEW_MASTER"; do
  case "$key" in
    *[!0-9a-f]*) printf 'rotate-keys: generated key is not hex\n' >&2; exit 1 ;;
  esac
  [ "${#key}" -eq 64 ] || {
    printf 'rotate-keys: generated key has unexpected length\n' >&2
    exit 1
  }
done

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
ENV_BAK="$ENV_FILE.bak-$STAMP"
cp -p "$ENV_FILE" "$ENV_BAK"
chmod 600 "$ENV_BAK"
printf 'rotate-keys: backed up LLM env to %s\n' "$ENV_BAK"

# Atomically rewrite the LLM env, preserving unrelated lines/comments.
TMP_ENV="$ENV_FILE.tmp.$$"
: >"$TMP_ENV"
chmod 600 "$TMP_ENV"
found_llama=0
found_master=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    LLAMA_API_KEY=*)
      printf 'LLAMA_API_KEY=%s\n' "$NEW_LLAMA" >>"$TMP_ENV"
      found_llama=1
      ;;
    LITELLM_MASTER_KEY=*)
      printf 'LITELLM_MASTER_KEY=%s\n' "$NEW_MASTER" >>"$TMP_ENV"
      found_master=1
      ;;
    *) printf '%s\n' "$line" >>"$TMP_ENV" ;;
  esac
done <"$ENV_FILE"
[ "$found_llama" -eq 1 ] || printf 'LLAMA_API_KEY=%s\n' "$NEW_LLAMA" >>"$TMP_ENV"
[ "$found_master" -eq 1 ] || printf 'LITELLM_MASTER_KEY=%s\n' "$NEW_MASTER" >>"$TMP_ENV"
mv -f "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf 'rotate-keys: wrote %s (0600)\n' "$ENV_FILE"

# Update the Companion-side master key (run-google-readonly.sh reads it).
# The destination was validated above, before /srv/llm/.env was touched.
if [ -f "$COMPANION_ENV" ]; then
  COMPANION_BAK="$COMPANION_ENV.bak-$STAMP"
  cp -p "$COMPANION_ENV" "$COMPANION_BAK"
  chmod 600 "$COMPANION_BAK"
  printf 'rotate-keys: backed up Companion env to %s\n' "$COMPANION_BAK"
else
  printf 'rotate-keys: %s was missing; creating it with the master key\n' "$COMPANION_ENV"
fi
TMP_COMPANION="$COMPANION_ENV.tmp.$$"
: >"$TMP_COMPANION"
chmod 600 "$TMP_COMPANION"
found_companion=0
if [ -f "$COMPANION_ENV" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      LITELLM_MASTER_KEY=*)
        printf 'LITELLM_MASTER_KEY=%s\n' "$NEW_MASTER" >>"$TMP_COMPANION"
        found_companion=1
        ;;
      *) printf '%s\n' "$line" >>"$TMP_COMPANION" ;;
    esac
  done <"$COMPANION_ENV"
fi
[ "$found_companion" -eq 1 ] ||
  printf 'LITELLM_MASTER_KEY=%s\n' "$NEW_MASTER" >>"$TMP_COMPANION"
mv -f "$TMP_COMPANION" "$COMPANION_ENV"
chmod 600 "$COMPANION_ENV"
printf 'rotate-keys: wrote %s (0600)\n' "$COMPANION_ENV"

# Recreate only the services that consume the keys.
PROJECT="${LLM_PROJECT:-$(
  docker inspect litellm --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true
)}"
[ -n "$PROJECT" ] || PROJECT=llm
printf 'rotate-keys: recreating gemma + litellm (project %s)\n' "$PROJECT"
env -u LLAMA_API_KEY -u LITELLM_MASTER_KEY \
  docker compose -p "$PROJECT" --project-directory "$LLM_DIR" \
  --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  up -d --force-recreate gemma litellm

printf 'rotate-keys: restarting companion.service\n'
systemctl --user restart companion.service

# Verify an authenticated LiteLLM call. The key travels via a 0600 curl
# config file, not argv, and is removed on exit.
CURL_CFG="$(mktemp "${TMPDIR:-/tmp}/litellm-curl.XXXXXX")"
trap 'rm -f "$CURL_CFG"' EXIT HUP INT TERM
chmod 600 "$CURL_CFG"
printf 'header = "Authorization: Bearer %s"\n' "$NEW_MASTER" >"$CURL_CFG"

verified=0
i=0
while [ "$i" -lt 30 ]; do
  code="$(
    curl -sS -o /dev/null -w '%{http_code}' --config "$CURL_CFG" \
      --max-time 10 "$BASE_URL/v1/models" 2>/dev/null || true
  )"
  if [ "$code" = "200" ]; then
    verified=1
    break
  fi
  sleep 2
  i=$((i + 1))
done

if [ "$verified" -ne 1 ]; then
  printf 'rotate-keys: LiteLLM verification failed; env backup: %s\n' "$ENV_BAK" >&2
  exit 1
fi

printf 'rotate-keys: complete; LiteLLM /v1/models returned 200\n'
