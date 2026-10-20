#!/bin/sh
# Polling auto-deploy for the remind CLI (single Linux host, user systemd,
# no inbound webhook). Run by remind-deploy.timer.
#
# Policy: candidates are built OUT-OF-TREE and released atomically. The
# remind repo checkout ($REMIND_DEPLOY_DIR, default ~/remind_master) is only
# a fetch source for origin/master; it is never switched, cleaned, or
# rebuilt in place. Each candidate is exported into
# $REMIND_RELEASES_DIR/<sha> (default ~/remind_releases/<sha>) via
# `git archive`, built there with npm ci + npm run build, and smoke-tested
# there. Only after the smoke passes is the Companion-facing symlink
# ($REMIND_CURRENT, default ~/remind_current) atomically re-pointed at the
# candidate release with `mv -T`. In-flight remind children keep running
# against the release directory they were spawned from (release dirs are
# immutable once built; the last 2 releases are kept), so no quiesce of
# Companion callers is needed. COMPANION_MEMORY_JSON must point its `entry`
# at ~/remind_current/dist/src/cli.js (see install.sh / docs/operations.md).
#
# Interrupted-deploy recovery: a state marker
# ($XDG_STATE_HOME/companion/remind-deploy.state, KEY=VALUE lines) records
# target/prev sha + phase before any step; phase becomes "ok" only after
# the smoke passes on the candidate. Every tick revalidates: if the
# marker/symlink/built artifact do not show a verified ok release for
# origin/master, the build + smoke pipeline re-runs (and rolls back to the
# recorded prev sha's release when the candidate fails).
#
# Logs go to stdout (journal). No secrets are printed.
# Single-instance via flock. Exit 0 = up-to-date or clean skip (retry next
# tick); exit 1 = refused or failed (rollback attempted).
set -eu

DEPLOY_DIR="${REMIND_DEPLOY_DIR:-$HOME/remind_master}"
REPO_OWNER="${REMIND_DEPLOY_REPO_OWNER:-suiso11}"
REPO_NAME="${REMIND_DEPLOY_REPO_NAME:-remind}"
REMIND_CONFIG="${REMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/remind/memory.config.json}"
RELEASES_DIR="${REMIND_RELEASES_DIR:-$HOME/remind_releases}"
CURRENT_LINK="${REMIND_CURRENT:-$HOME/remind_current}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/companion"
STATE_FILE="$STATE_DIR/remind-deploy.state"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/remind-deploy.lock"
SMOKE_TIMEOUT_SECS="${REMIND_SMOKE_TIMEOUT:-30}"

log() {
  printf '%s remind-deploy: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# systemd loads EnvironmentFile; manual runs fall back to reading the one
# COMPANION_MEMORY_JSON line (never echoed) so the smoke call matches the
# exact executable/entry/config/scope Companion uses.
load_memory_json() {
  if [ -n "${COMPANION_MEMORY_JSON:-}" ]; then
    return 0
  fi
  _env_file="${COMPANION_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/companion/env}"
  [ -r "$_env_file" ] || return 0
  _line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPANION_MEMORY_JSON=' \
    "$_env_file" | tail -n 1 || true)"
  [ -n "$_line" ] || return 0
  _value="${_line#*=}"
  case "$_value" in
    \"*\") _value="${_value#\"}" && _value="${_value%\"}" ;;
    \'*\') _value="${_value#\'}" && _value="${_value%\'}" ;;
  esac
  COMPANION_MEMORY_JSON="$_value"
  unset _env_file _line _value
}

# --- deploy state marker (KEY=VALUE lines: target, phase, prev) -----------
# Written before any build/switch; phase becomes "ok" only after smoke
# passes, so a crash/reboot mid-deploy leaves a non-ok marker and the next
# tick rebuilds + revalidates instead of trusting the tree.
state_get() {
  [ -r "$STATE_FILE" ] || return 1
  grep -E "^$1=" "$STATE_FILE" | tail -n 1 | cut -d= -f2-
}

state_write() { # target phase prev
  mkdir -p "$STATE_DIR"
  _state_tmp="$STATE_FILE.tmp.$$"
  {
    printf 'target=%s\n' "$1"
    printf 'phase=%s\n' "$2"
    printf 'prev=%s\n' "$3"
  } >"$_state_tmp"
  mv -f "$_state_tmp" "$STATE_FILE"
  unset _state_tmp
}

# Restore the recorded previous release as the serving one (only possible
# once that release exists; otherwise the symlink is left untouched).
rollback() {
  if [ -n "$PREV" ] && [ -d "$RELEASES_DIR/$PREV" ] &&
    [ -f "$RELEASES_DIR/$PREV/dist/src/cli.js" ]; then
    log "rolling back to release $PREV"
    ln -sfn "$RELEASES_DIR/$PREV" "$CURRENT_LINK.tmp.$$"
    mv -Tf "$CURRENT_LINK.tmp.$$" "$CURRENT_LINK"
    state_write "$PREV" ok ""
  else
    log "no previous verified release to roll back to; $CURRENT_LINK unchanged"
  fi
}

# --- single-instance lock (non-blocking; a held lock is a clean skip) ---
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another deploy run holds the lock; skipping this tick"
  exit 0
fi

if [ ! -d "$DEPLOY_DIR/.git" ] && [ ! -f "$DEPLOY_DIR/.git" ]; then
  log "deploy dir $DEPLOY_DIR is not a git checkout; refusing"
  exit 1
fi
cd "$DEPLOY_DIR"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

git fetch origin
TARGET="$(git rev-parse origin/master)"
PREV_TARGET="$(state_get target || true)"
PREV_PHASE="$(state_get phase || true)"
PREV_RAW="$(state_get prev || true)"
PREV=""
if [ "$PREV_PHASE" = "ok" ] && [ -n "$PREV_TARGET" ] &&
  [ "$PREV_TARGET" != "$TARGET" ]; then
  PREV="$PREV_TARGET"
elif [ "$PREV_PHASE" != "ok" ] && [ -n "$PREV_RAW" ]; then
  PREV="$PREV_RAW"
fi
RELEASE="$RELEASES_DIR/$TARGET"
CUR_RESOLVED="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"

# --- fast path: verified ok release for origin/master already serving -----
# Revalidation per tick: require marker ok for TARGET, symlink resolved at
# TARGET's release dir, and the built CLI artifact present. An interrupted
# deploy (crash/reboot between steps) fails these checks, so the pipeline
# below re-runs instead of permanently trusting a half-updated tree.
if [ "$PREV_PHASE" = "ok" ] && [ "$PREV_TARGET" = "$TARGET" ] &&
  [ "$CUR_RESOLVED" = "$RELEASE" ] &&
  [ -f "$RELEASE/dist/src/cli.js" ] && [ -x "$RELEASE/dist/src/cli.js" ]; then
  log "$CURRENT_LINK already serves verified $TARGET; nothing to do"
  exit 0
fi
if [ -n "$CUR_RESOLVED" ] && [ "$CUR_RESOLVED" != "$RELEASE" ]; then
  log "candidate release switch: $(basename "$CUR_RESOLVED") -> $TARGET"
else
  log "building/revalidating release for $TARGET"
fi

# --- CI gate: target commit must be green. gh missing/unauthed => skip. ---
if ! command -v gh >/dev/null 2>&1; then
  log "gh not available; skipping deploy this tick (retry later)"
  exit 0
fi
# Aggregate every page before parsing: `gh api --paginate` emits each page
# as a separate JSON object, so pages must be collected first (via --slurp
# when the installed gh supports it, else streamed one run per line and
# whitespace-joined inside a single JSON array); the aggregator below only
# parses that one aggregated form.
if gh api --help 2>/dev/null | grep -q -- '--slurp'; then
  CHECK_RUNS_JSON="$(gh api \
    "repos/${REPO_OWNER}/${REPO_NAME}/commits/${TARGET}/check-runs" \
    --paginate --slurp 2>/dev/null)" || CHECK_RUNS_JSON=""
else
  CHECK_RUNS_JSON="[$(
    gh api "repos/${REPO_OWNER}/${REPO_NAME}/commits/${TARGET}/check-runs" \
      --paginate --jq '.check_runs[]' 2>/dev/null | tr '\n' ' '
  )]" || CHECK_RUNS_JSON="[ ]"
fi
if [ -z "$CHECK_RUNS_JSON" ]; then
  log "gh api for check-runs failed (unauthed/offline?); skipping deploy this tick"
  exit 0
fi
CI_OK="$(CHECK_RUNS_JSON="$CHECK_RUNS_JSON" node --input-type=module -e '
const raw = process.env.CHECK_RUNS_JSON ?? "[]";
let doc;
try {
  doc = JSON.parse(raw);
} catch {
  process.stdout.write("parse-error");
  process.exit(0);
}
// doc is an array of page objects (--slurp), a flat array of check runs
// (fallback stream), or a single page object. Aggregate every check_runs
// we can see across pages before judging greenness.
let runs = [];
if (Array.isArray(doc)) {
  if (doc.length > 0 && doc[0] && typeof doc[0] === "object" && "check_runs" in doc[0]) {
    for (const page of doc) {
      if (page && Array.isArray(page.check_runs)) runs.push(...page.check_runs);
    }
  } else {
    runs = doc;
  }
} else if (doc && typeof doc === "object" && Array.isArray(doc.check_runs)) {
  runs = doc.check_runs;
}
if (runs.length === 0) {
  process.stdout.write("no-checks");
  process.exit(0);
}
const bad = runs.filter(
  (r) => r.status !== "completed" || (r.conclusion !== "success" && r.conclusion !== "skipped"),
);
if (bad.length === 0) {
  process.stdout.write("green");
} else {
  process.stdout.write(`not-green:${bad.map((r) => `${r.name ?? "?"}:${r.status ?? "?"}/${r.conclusion ?? "?"}`).join(",")}`);
}
')"
case "$CI_OK" in
  green)
    log "CI green for $TARGET"
    ;;
  *)
    log "CI not green for $TARGET ($CI_OK); skipping deploy this tick"
    exit 0
    ;;
esac

# --- out-of-tree build: export candidate -> npm ci -> npm build -----------
# `git archive` exports the candidate commit, so $DEPLOY_DIR's working tree
# is never touched and an interrupted build is always retryable by
# rebuilding $RELEASE (guarded by the non-ok marker).
state_write "$TARGET" building "$PREV"
if ! { rm -rf "$RELEASE" && mkdir -p "$RELEASE" &&
  git archive "$TARGET" | tar -x -C "$RELEASE" &&
  (cd "$RELEASE" && npm ci && npm run build); }; then
  log "archive/install/build failed for $TARGET; keeping previous release"
  state_write "$TARGET" failed "$PREV"
  rollback
  exit 1
fi
cd "$DEPLOY_DIR"

# --- smoke gate: one real record.list call must answer a production-grade
# ok envelope (exact framing + key set + types, mirroring the production
# client parse rules). The candidate entry is always the just-built release
# CLI, so a stale COMPANION_MEMORY_JSON entry pointing at ~/remind_current
# can never mask a broken candidate.
load_memory_json
MEMORY_JSON="${COMPANION_MEMORY_JSON:-}"
fail_refuse() {
  log "$*"
  state_write "$TARGET" failed "$PREV"
  rollback
  exit 1
}
if ! SCOPE="$(node "$SCRIPT_DIR/remindDeploy.mjs" field scope \
  --memory-json "$MEMORY_JSON" \
  --config "$REMIND_CONFIG")" || [ -z "$SCOPE" ]; then
  fail_refuse "cannot resolve a smoke-test scope from COMPANION_MEMORY_JSON or $REMIND_CONFIG; refusing"
fi
if ! SMOKE_EXEC="$(node "$SCRIPT_DIR/remindDeploy.mjs" field executable \
  --memory-json "$MEMORY_JSON" --fallback "$(command -v node)")"; then
  fail_refuse "cannot resolve the remind executable; refusing"
fi
SMOKE_ENTRY="$RELEASE/dist/src/cli.js"
if ! SMOKE_CONFIG="$(node "$SCRIPT_DIR/remindDeploy.mjs" field config \
  --memory-json "$MEMORY_JSON" --fallback "$REMIND_CONFIG")"; then
  fail_refuse "cannot resolve the remind config path; refusing"
fi
SMOKE_REQUEST="$(SCOPE="$SCOPE" node --input-type=module -e '
process.stdout.write(JSON.stringify({ v: 1, op: "record.list", params: { scope: process.env.SCOPE } }));
')"

# Bounded smoke: `timeout 30` when available (timeout maps to the failure
# and rollback path), else a node watchdog that SIGKILLs the candidate.
run_smoke_bounded() { # stdout of the candidate -> $1 (bytes preserved)
  _smoke_out="$1"
  if command -v timeout >/dev/null 2>&1; then
    printf '%s\n' "$SMOKE_REQUEST" |
      timeout "$SMOKE_TIMEOUT_SECS" "$SMOKE_EXEC" "$SMOKE_ENTRY" \
        --config "$SMOKE_CONFIG" 2>/dev/null >"$_smoke_out"
  else
    SMOKE_EXEC="$SMOKE_EXEC" SMOKE_ENTRY="$SMOKE_ENTRY" \
      SMOKE_CONFIG="$SMOKE_CONFIG" SMOKE_REQUEST="$SMOKE_REQUEST" \
      SMOKE_TIMEOUT_SECS="$SMOKE_TIMEOUT_SECS" SMOKE_OUT_PATH="$_smoke_out" \
      node --input-type=module -e '
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
const out = createWriteStream(process.env.SMOKE_OUT_PATH);
const child = spawn(process.env.SMOKE_EXEC, [process.env.SMOKE_ENTRY, "--config", process.env.SMOKE_CONFIG], {
  stdio: ["pipe", "pipe", "ignore"],
});
child.stdout.pipe(out);
const timer = setTimeout(() => {
  child.kill("SIGKILL");
}, Number(process.env.SMOKE_TIMEOUT_SECS) * 1000);
child.on("close", (code) => {
  clearTimeout(timer);
  out.end();
  process.exit(code === 0 ? 0 : 1);
});
child.stdin.end(`${process.env.SMOKE_REQUEST}\\n`);
' 2>/dev/null
  fi
}

SMOKE_TMP="$(mktemp "${XDG_RUNTIME_DIR:-/tmp}/remind-smoke.XXXXXX")"
SMOKE_FAILED=0
if ! run_smoke_bounded "$SMOKE_TMP"; then
  SMOKE_FAILED=1
elif ! node "$SCRIPT_DIR/remindDeploy.mjs" check-ok <"$SMOKE_TMP"; then
  SMOKE_FAILED=1
fi
rm -f "$SMOKE_TMP"
if [ "$SMOKE_FAILED" != "0" ]; then
  fail_refuse "smoke test failed for $TARGET (record.list did not return a valid ok envelope); rolling back"
fi

# --- atomic publish -------------------------------------------------------
# Re-point $CURRENT_LINK at the verified release in one `mv -T`; readers
# see either the old or the new release, never a partial tree (in-flight
# children keep their own release directory's files).
ln -sfn "$RELEASE" "$CURRENT_LINK.tmp.$$"
if ! mv -Tf "$CURRENT_LINK.tmp.$$" "$CURRENT_LINK"; then
  fail_refuse "failed to switch $CURRENT_LINK to $RELEASE; rolling back"
fi
state_write "$TARGET" ok "$PREV"

# Keep the last 2 releases (the published candidate + the previously
# verified one); in-flight children only ever need their own dir.
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null |
  sort -rn |
  tail -n +3 |
  while IFS= read -r _age old; do
    case "$old" in
      "$RELEASE") continue ;;
      "$RELEASES_DIR/$PREV") continue ;;
    esac
    log "pruning old release $old"
    rm -rf "$old"
  done

log "released $TARGET via $CURRENT_LINK (smoke ok; in-flight calls keep their release)"
