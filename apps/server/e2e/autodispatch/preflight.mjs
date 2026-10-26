// Auto-dispatch fixture preflight (test-only).
//
// A timed-out previous Playwright run can leave the autodispatch fixture
// process listening on 4194/4195 with its real pi-orch child. A fresh run
// MUST NOT reuse that process: its code may be old and its durable global
// control state may differ. This script terminates ONLY a process that
// proves BOTH:
//   1. its argv names this exact fixture entrypoint, and
//   2. its cwd is this apps/server directory.
// No port-wide kill, no service/global process, and no production port 3000
// handling. The PID file is written by the fixture itself into OS tmp.

import {
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SERVER_DIR = realpathSync(join(HERE, "..", ".."));
const FIXTURE_ARG = "e2e/autodispatch/server.ts";
const PID_FILE = join(
  tmpdir(),
  `companion-autodispatch-e2e-fixture-${process.getuid?.() ?? "user"}.pid`,
);

function argvOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
  } catch {
    return null;
  }
}

function cwdOf(pid) {
  try {
    return realpathSync(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return null;
  }
}

function isOwnFixture(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const argv = argvOf(pid);
  const cwd = cwdOf(pid);
  if (argv === null || cwd === null || cwd !== APP_SERVER_DIR) return false;
  const executable = argv[0] ?? "";
  if (!/(^|\/)node(?:$|[0-9.]+$)/.test(executable)) return false;
  // Match an exact node argument, never a shell `-c` string that merely
  // mentions this entrypoint (the webServer wrapper is one such shell).
  const absolute = join(APP_SERVER_DIR, FIXTURE_ARG);
  return argv.slice(1).some((arg) => arg === FIXTURE_ARG || arg === absolute);
}

function allPids() {
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number(name));
  } catch {
    return [];
  }
}

const candidates = new Set();
try {
  const recorded = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (isOwnFixture(recorded)) candidates.add(recorded);
} catch {
  // No/stale PID file: fall through to the precise /proc scan.
}
for (const pid of allPids()) {
  if (isOwnFixture(pid)) candidates.add(pid);
}

for (const pid of candidates) {
  try {
    process.kill(pid, "SIGTERM");
    process.stderr.write(`autodispatch-e2e-preflight: SIGTERM ${pid}\n`);
  } catch {
    // Already gone.
  }
}

const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  if ([...candidates].every((pid) => !isOwnFixture(pid))) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const remaining = [...candidates].filter(isOwnFixture);
if (remaining.length > 0) {
  // Never SIGKILL an unproven/uncooperative process; report the blocker.
  process.stderr.write(
    `autodispatch-e2e-preflight: fixture still alive: ${remaining.join(",")}\n`,
  );
  process.exit(1);
}
try {
  unlinkSync(PID_FILE);
} catch {
  // Removed by the fixture teardown already.
}
// No own fixture is alive now, so every remaining synthetic root under our
// fixed prefix belongs to a previous interrupted run. Remove only those
// fixture roots (never unrelated /tmp entries or the production service).
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith("companion-autodispatch-e2e-")) continue;
  if (name.endsWith(".pid")) continue;
  try {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  } catch {
    // Best effort; a permission/race failure is not a correctness blocker.
  }
}
process.stderr.write("autodispatch-e2e-preflight: clear\n");
