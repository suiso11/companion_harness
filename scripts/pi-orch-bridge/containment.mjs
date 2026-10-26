// Confined process execution for the sealed bridge.
//
// The only production backend is "confined": systemd user scope + bwrap. If
// either the binaries or the user systemd bus are unavailable the bridge
// returns an explicit containment blocker; it never falls back to a host
// process and never claims containment from binary presence alone.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync as nodeReaddirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LIB_DIRS = ["/usr", "/bin", "/lib", "/lib64"];

export function preflightContainment(runtime) {
  for (const key of [
    "bwrapRealpath",
    "systemdRunRealpath",
    "systemctlRealpath",
  ]) {
    if (typeof runtime[key] !== "string" || !existsSync(runtime[key])) {
      return { ok: false, reason: `missing runtime binary: ${key}` };
    }
  }
  const bwrap = spawnSync(runtime.bwrapRealpath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (bwrap.status !== 0)
    return { ok: false, reason: "bwrap --version failed" };
  const scope = spawnSync(
    runtime.systemdRunRealpath,
    ["--user", "--scope", "--quiet", "-p", "MemoryMax=64M", "true"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (scope.status !== 0) {
    return {
      ok: false,
      reason:
        "user systemd scope unavailable (no DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR or systemd user bus)",
    };
  }
  return { ok: true };
}

/**
 * Private work copy of the sealed snapshot, made OUTSIDE the original source
 * root. Symlinks are rejected after the copy; the snapshot itself was already
 * verified content-addressed.
 */
export function materializeSealedWork(snapshotRoot, workRoot) {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  chmodSync(workRoot, 0o700);
  cpSync(snapshotRoot, workRoot, {
    recursive: true,
    preserveTimestamps: false,
    force: true,
  });
  const walk = (absolute, rel) => {
    const st = lstatSync(absolute);
    if (st.isSymbolicLink())
      throw new Error(`copied work contains a symlink: ${rel}`);
    if (st.isDirectory()) {
      chmodSync(absolute, 0o700);
      const names = [];
      for (const name of nodeReaddirSync(absolute)) names.push(name);
      for (const name of names) walk(join(absolute, name), `${rel}/${name}`);
      return;
    }
    if (!st.isFile())
      throw new Error(`copied work contains a non-regular entry: ${rel}`);
    chmodSync(absolute, (st.mode & 0o111) !== 0 ? 0o700 : 0o600);
  };
  for (const name of nodeReaddirSync(workRoot))
    walk(join(workRoot, name), name);
  return workRoot;
}

function ensureDir(args, dir) {
  if (dir === "" || dir === "/") return;
  args.push("--dir", dir);
}

function pushRoBindWithParents(args, source, target, existing) {
  const parts = dirname(target).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (existing.has(current)) continue;
    ensureDir(args, current);
    existing.add(current);
  }
  args.push("--ro-bind", source, target);
}

function realPiArgs(profile) {
  if (profile.executor?.kind !== "real-pi") return [];
  const runtime = profile.runtime;
  const root = dirname(dirname(runtime.piOrchLauncherRealpath));
  return [
    "--dir",
    "/piorch",
    "--dir",
    "/piorch/scripts",
    "--dir",
    "/piorch/.pi",
    "--dir",
    "/piorch/.pi/extensions",
    "--ro-bind",
    runtime.piOrchLauncherRealpath,
    "/piorch/scripts/pi-orch.mjs",
    "--ro-bind",
    runtime.piOrchShellRealpath,
    "/piorch/scripts/pi_codex_orchestrator.sh",
    "--ro-bind",
    runtime.piOrchConfigRealpath,
    "/piorch/scripts/omp-orchestrator.yml",
    "--ro-bind",
    dirname(runtime.piOrchExtensionRealpath),
    "/piorch/.pi/extensions/opencode-orchestrator",
    "--ro-bind",
    join(root, "node_modules"),
    "/piorch/node_modules",
  ];
}

function baseBwrapArgs(profile) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const dir of LIB_DIRS) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  for (const file of [
    "/etc/ld.so.cache",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
  ]) {
    if (existsSync(file)) args.push("--ro-bind", file, file);
  }
  if (existsSync("/etc/ssl")) args.push("--ro-bind", "/etc/ssl", "/etc/ssl");
  // Pinned runtimes are bound at their own host paths read-only. No /home,
  // host node_modules, or host $HOME is bound; only these exact files exist.
  const existing = new Set([...LIB_DIRS, "/proc", "/dev", "/tmp", "/etc"]);
  for (const key of ["nodeRealpath", "ompRealpath"]) {
    const path = profile.runtime[key];
    if (typeof path === "string" && existsSync(path)) {
      pushRoBindWithParents(args, path, path, existing);
    }
  }
  args.push(...realPiArgs(profile));
  return args;
}

export function guestPathEnvironment(profile) {
  const dirs = new Set(["/usr/local/bin", "/usr/bin", "/bin"]);
  for (const key of ["nodeRealpath", "ompRealpath"]) {
    const path = profile.runtime[key];
    if (typeof path === "string") dirs.add(dirname(path));
  }
  return [...dirs].join(":");
}

function dependencyArgs(dependencies) {
  const args = [];
  for (const mount of dependencies.mounts) {
    args.push("--ro-bind", mount.source, mount.guestPath);
  }
  return args;
}

/**
 * Wholejob executor command. The executor executable and argv come only from
 * the frozen operator profile. The guest sees the private /work copy, the
 * read-only dependency closure, a dummy bearer token, and a UDS relay path;
 * the real credential stays in the trusted host relay.
 */
export function buildWholejobCommand(profile, paths, scopeUnit, options = {}) {
  // The guest must stop before the bridge's outer deadline. The effective
  // bound is min(request budget, frozen profile duration); round DOWN to
  // whole seconds so the guest never gets a wider window than the grant.
  const guestTimeoutSeconds = Math.max(
    1,
    Math.floor((options.guestTimeoutMs ?? profile.limits.maxDurationMs) / 1000),
  );
  const args = [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${scopeUnit}`,
    `-p`,
    `MemoryMax=${profile.limits.memoryMaxBytes}`,
    `-p`,
    "MemorySwapMax=0",
    `-p`,
    `TasksMax=${profile.limits.maxProcesses}`,
    `-p`,
    `CPUQuota=${profile.limits.cpuQuotaPercent}%`,
    // The TrialRunner observer derives the trusted runtime bound from the
    // transient scope's finite RuntimeMaxUSec; without it systemd reports
    // "infinity" and the runner fails closed with no permit. Pin the SAME
    // frozen profile duration the bridge deadline already uses, in exact
    // milliseconds: rounding a non-whole-second cap up would widen the unit
    // beyond the frozen budget and the kernel permit would (correctly) deny.
    `-p`,
    `RuntimeMaxSec=${Math.max(1, profile.limits.maxDurationMs)}ms`,
    // systemd-run is the command itself; bwrap is the program it launches in
    // the transient scope. Repeating systemd-run here would nest a second
    // transient unit and fail with an interactive-auth denial.
    profile.runtime.bwrapRealpath,
    ...baseBwrapArgs(profile),
    "--ro-bind",
    paths.executorExecutable,
    paths.executorExecutable,
    "--bind",
    paths.workRoot,
    "/work",
    // Private scratch tmpfs for HOME/TMPDIR: OMP model config, caches, and
    // native artifacts stay here and never pollute the /work source copy.
    "--tmpfs",
    "/scratch",
    "--ro-bind",
    paths.jobFile,
    "/run/companion-job.json",
    "--ro-bind",
    profile.model.sockHostPath,
    "/run/model.sock",
    ...dependencyArgs(profile.dependencies),
    "--setenv",
    "PATH",
    guestPathEnvironment(profile),
    "--setenv",
    "HOME",
    "/scratch",
    "--setenv",
    "TMPDIR",
    "/scratch",
    "--setenv",
    "COMPANION_JOB_FILE",
    "/run/companion-job.json",
    "--setenv",
    "COMPANION_MODEL_UDS",
    "/run/model.sock",
    "--setenv",
    "COMPANION_MODEL_TOKEN",
    "dummy-bearer-not-a-secret",
    "--setenv",
    "COMPANION_NODE_BIN",
    profile.runtime.nodeRealpath ?? "/usr/bin/node",
    "--setenv",
    "COMPANION_OMP_BIN",
    profile.runtime.ompRealpath ?? "",
    "--setenv",
    "COMPANION_EXECUTOR_KIND",
    profile.executor.kind ?? "fixed",
    "--setenv",
    "COMPANION_PI_ORCH_LAUNCHER",
    profile.executor.kind === "real-pi" ? "/piorch/scripts/pi-orch.mjs" : "",
    "--setenv",
    "COMPANION_OBSERVATION_REL",
    ".companion-observation/guest.json",
    "--setenv",
    "COMPANION_GUEST_TIMEOUT_SECONDS",
    String(guestTimeoutSeconds),
    "--setenv",
    "COMPANION_MAX_MODEL_CALLS",
    String(profile.limits.maxModelCalls),
    "--setenv",
    "COMPANION_MAX_OUTPUT_TOKENS",
    String(profile.limits.maxOutputTokens),
    "--setenv",
    "COMPANION_MAX_MODEL_CALL_MS",
    String(profile.limits.maxModelCallMs),
    "--setenv",
    "COMPANION_MODEL_CONCURRENCY",
    String(profile.limits.modelConcurrency),
    "--chdir",
    "/work",
    "--",
    profile.executor.executable,
    ...profile.executor.args,
  ];
  return { command: profile.runtime.systemdRunRealpath, args };
}

export function buildCheckCommand(profile, paths, scopeUnit, check) {
  const args = [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${scopeUnit}`,
    `-p`,
    `MemoryMax=${profile.limits.memoryMaxBytes}`,
    `-p`,
    "MemorySwapMax=0",
    `-p`,
    `TasksMax=${profile.limits.maxProcesses}`,
    `-p`,
    `CPUQuota=${profile.limits.cpuQuotaPercent}%`,
    // Same single-level scope contract as the wholejob command.
    profile.runtime.bwrapRealpath,
    ...baseBwrapArgs(profile),
    "--ro-bind",
    check.executable,
    check.executable,
    "--ro-bind",
    paths.workRoot,
    "/work",
    "--bind",
    paths.scratchRoot,
    "/scratch",
    ...dependencyArgs(profile.dependencies),
    "--setenv",
    "PATH",
    guestPathEnvironment(profile),
    "--setenv",
    "HOME",
    "/scratch",
    "--setenv",
    "TMPDIR",
    "/scratch",
    "--chdir",
    "/work",
    "--",
    check.executable,
    ...check.args,
  ];
  return { command: profile.runtime.systemdRunRealpath, args };
}

export function stopOwnedScope(runtime, unit, signal) {
  if (!/^capsule-[0-9a-f-]{36}-[A-Za-z0-9_-]{8,64}\.scope$/i.test(unit)) return;
  const result = spawnSync(
    runtime.systemctlRealpath,
    ["--user", "kill", `--signal=${signal}`, unit],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  void result;
}

/**
 * Spawn and observe one fixed command. Output is capped and returned only to
 * the bridge for check matching; it is never copied into stdout artifact
 * payloads or forwarded raw to diagnostics.
 */
export function spawnObserved(command, args, options) {
  return new Promise((resolve, reject) => {
    // systemd-run/systemctl need the caller's user bus even though the guest
    // itself is launched with an explicit bwrap --setenv environment. Forward
    // only these two locator variables; never the rest of the host env.
    const defaultEnv = { PATH: "/usr/local/bin:/usr/bin:/bin" };
    for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      if (typeof process.env[key] === "string" && process.env[key] !== "")
        defaultEnv[key] = process.env[key];
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env ?? defaultEnv,
    });
    options.onChild?.(child);
    const cap = options.outputCap ?? 64 * 1024;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const collect = (current, chunk) => {
      if (current.length >= cap) return current;
      const room = cap - current.length;
      return Buffer.concat([current, Buffer.from(chunk).subarray(0, room)]);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export function createJobFile(path, job) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(job)}\n`;
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function copyBoundedFile(source, destination, maxBytes) {
  const st = lstatSync(source);
  if (!st.isFile() || st.size > maxBytes) return false;
  const fdIn = openSync(source, "r");
  const fdOut = openSync(destination, "w", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fdIn, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      writeSync(fdOut, buffer.subarray(0, read));
    }
  } finally {
    closeSync(fdIn);
    closeSync(fdOut);
  }
  return true;
}
