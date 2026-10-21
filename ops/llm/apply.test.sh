#!/bin/sh
# Test for ops/llm/apply.sh --yes.
#
# Isolation is the whole point of this test: it must never touch the real
# docker daemon or /srv/llm.
#   - docker is stubbed via a PATH shim (records argv, exits 0)
#   - the destination is a throwaway temp dir (never /srv/llm)
#   - the shim PATH is only exported for the apply.sh subprocess
#
# Usage: ops/llm/apply.test.sh   (no env needed; prints PASS/FAIL lines)

set -eu
umask 022

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# --- temp target dir (never /srv/llm) -------------------------------------
TARGET="$(mktemp -d "${TMPDIR:-/tmp}/apply-test.XXXXXX")"
trap 'rm -rf "$TARGET" "$SHIM_DIR" "$LOG"' EXIT INT TERM
printf 'LLM_HEALTHCHECK_TOKEN=test\n' >"$TARGET/.env"

# --- docker shim (PATH stub) ----------------------------------------------
SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/apply-shim.XXXXXX")"
LOG="$(mktemp "${TMPDIR:-/tmp}/apply-dockerlog.XXXXXX")"
cat >"$SHIM_DIR/docker" <<EOF
#!/bin/sh
# stub: record argv and exit 0; never talks to a real daemon
for a in "\$@"; do printf '%s\n' "\$a" >>"$LOG"; done
exit 0
EOF
chmod 755 "$SHIM_DIR/docker"

# The apply script must not be able to escape the stub: run it with the shim
# first on PATH and an explicitly temp --dest.
export PATH="$SHIM_DIR:$PATH"
OUT="$("$SCRIPT_DIR/apply.sh" --yes --dest "$TARGET" 2>&1)" || {
  printf '%s\n' "$OUT" >&2
  fail 'apply.sh --yes exited non-zero'
}

# --- assertions -------------------------------------------------------------
# 1. files copied to the temp target
for f in compose.yaml litellm_config.yaml searxng/settings.yml; do
  [ -f "$TARGET/$f" ] || fail "expected $f in temp target"
done
cmp -s "$SCRIPT_DIR/compose.yaml" "$TARGET/compose.yaml" ||
  fail 'compose.yaml copy mismatch'
cmp -s "$SCRIPT_DIR/searxng/settings.yml" "$TARGET/searxng/settings.yml" ||
  fail 'settings.yml copy mismatch'

# 2. secret generated in the temp .env, value never printed to stdout
grep -q '^SEARXNG_SECRET=[0-9a-f]\{64\}$' "$TARGET/.env" ||
  fail 'SEARXNG_SECRET not generated in temp .env'
case "$OUT" in
  *SEARXNG_SECRET=*) fail 'secret value leaked into apply.sh output' ;;
esac

# 3. docker was only ever invoked via the shim, against the temp dir
grep -q "compose" "$LOG" || fail 'docker compose was never invoked'
if grep -q '^/srv/llm' "$LOG"; then
  fail 'apply.sh targeted /srv/llm instead of the temp dir'
fi
if grep -q '^up$\|^-d$' "$LOG" && ! grep -q -- "--project-directory" "$LOG"; then
  fail 'unexpected docker invocation shape'
fi
# searxng settings changed -> searxng must be force-recreated
grep -q -- "--force-recreate" "$LOG" || fail 'expected --force-recreate'
grep -q '^searxng$' "$LOG" || fail 'expected searxng in recreate list'

# --- compose-only change ----------------------------------------------------
# Only compose.yaml differs: no bind-mounted config changed, so apply.sh must
# still exit 0 and reconcile the stack (gemma) with a plain `up -d`. This is
# the regression case for the RECREATE_SERVICES unbound-variable bug.
printf '\n# stale\n' >>"$TARGET/compose.yaml"
: >"$LOG"
OUT2="$("$SCRIPT_DIR/apply.sh" --yes --dest "$TARGET" 2>&1)" || {
  printf '%s\n' "$OUT2" >&2
  fail 'apply.sh --yes (compose-only) exited non-zero'
}
cmp -s "$SCRIPT_DIR/compose.yaml" "$TARGET/compose.yaml" ||
  fail 'compose.yaml was not refreshed on compose-only apply'
grep -q '^compose$' "$LOG" || fail 'docker compose not invoked on compose-only change'
grep -q '^up$' "$LOG" || fail 'expected compose up on compose-only change'
# No explicit service list: plain `up -d` reconciles every service, gemma included.
if grep -q -- '--force-recreate' "$LOG"; then
  fail 'compose-only change must not force-recreate bind-mounted services'
fi

printf 'PASS: apply.sh --yes isolated (temp dest %s, docker shimmed)\n' "$TARGET"
printf 'PASS: apply.sh --yes compose-only change reconciles without force-recreate\n'
