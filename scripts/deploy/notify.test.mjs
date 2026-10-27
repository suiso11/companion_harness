// Tests for scripts/deploy/notify.sh env handling.
//
// Regression context (fix/deploy-notify-config, live bug 2026-10-27): the
// deploy/health systemd units load only ~/.config/companion/env, which does
// not define COMPANION_DB_PATH. notify.sh's fallback still assigned and
// exported an EMPTY COMPANION_DB_PATH, and loadServerConfig rejects an empty
// path, so every notice failed with "invalid configuration". These tests run
// the real script with a stub `pnpm` and assert what the CLI would receive.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "notify.sh");

const cleanups = [];

function fixture(envFileContents) {
  const root = mkdtempSync(join(tmpdir(), "notify-sh-test-"));
  cleanups.push(root);
  const deployDir = join(root, "deploy");
  const binDir = join(root, "bin");
  const envFile = join(root, "env");
  const capture = join(root, "capture");
  mkdirp(deployDir);
  mkdirp(binDir);
  writeFileSync(envFile, envFileContents);
  // Stub pnpm: record whether COMPANION_DB_PATH reached the child env.
  writeFileSync(
    join(binDir, "pnpm"),
    [
      "#!/bin/sh",
      'if [ -n "${COMPANION_DB_PATH+x}" ]; then',
      '  printf "set:%s" "$COMPANION_DB_PATH" > "$CAPTURE"',
      "else",
      '  printf "unset" > "$CAPTURE"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "pnpm"), 0o755);
  const env = { ...process.env };
  delete env.COMPANION_DB_PATH;
  env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  env.COMPANION_DEPLOY_DIR = deployDir;
  env.COMPANION_ENV_FILE = envFile;
  env.CAPTURE = capture;
  execFileSync("sh", [SCRIPT_PATH, "info", "t", "b", "ops:test:abc", "s"], {
    env,
    stdio: "pipe",
  });
  return readFileSync(capture, "utf8");
}

function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("notify.sh COMPANION_DB_PATH fallback", () => {
  it("leaves the variable unset when the env file has no DB path", () => {
    expect(fixture("COMPANION_REMOTE_JSON={}\n")).toBe("unset");
  });

  it("leaves the variable unset when the env file line is empty", () => {
    expect(fixture('COMPANION_DB_PATH=""\n')).toBe("unset");
  });

  it("exports the quoted DB path when the env file defines it", () => {
    expect(fixture("COMPANION_DB_PATH='/home/u/companion.db'\n")).toBe(
      "set:/home/u/companion.db",
    );
  });

  it("does not override an already-exported DB path", () => {
    const root = mkdtempSync(join(tmpdir(), "notify-sh-test-"));
    cleanups.push(root);
    const deployDir = join(root, "deploy");
    const binDir = join(root, "bin");
    const capture = join(root, "capture");
    mkdirp(deployDir);
    mkdirp(binDir);
    writeFileSync(
      join(binDir, "pnpm"),
      `#!/bin/sh\nprintf "set:%s" "$COMPANION_DB_PATH" > "$CAPTURE"\n`,
    );
    chmodSync(join(binDir, "pnpm"), 0o755);
    const env = { ...process.env };
    env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    env.COMPANION_DEPLOY_DIR = deployDir;
    env.COMPANION_ENV_FILE = join(root, "missing-env");
    env.COMPANION_DB_PATH = "/explicit/companion.db";
    env.CAPTURE = capture;
    execFileSync("sh", [SCRIPT_PATH, "info", "t", "b", "ops:test:abc", "s"], {
      env,
      stdio: "pipe",
    });
    expect(readFileSync(capture, "utf8")).toBe("set:/explicit/companion.db");
  });
});
