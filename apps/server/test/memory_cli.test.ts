// Memory CLI client tests: bounded spawn contract over fake executables.
//
// Every test runs a real child process (process.execPath + a temp script,
// shell never used) and asserts the exact argv/stdin contract plus strict
// stdout validation, byte caps, timeout kill, and abort behavior. Temp
// scripts live under an owned TMPDIR and are removed afterwards.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  callMemoryCli,
  type MemoryCliAddress,
  MemoryCliError,
  parseMemoryCliStdout,
} from "../src/memory_cli.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-memory-cli-"));
  tempDirs.push(dir);
  return dir;
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

function addressOf(
  entry: string,
  overrides: Partial<MemoryCliAddress> = {},
): MemoryCliAddress {
  return {
    executable: process.execPath,
    entry,
    config: join(tempDir(), "memory.config.json"),
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    ...overrides,
  };
}

const ENVELOPE_SCRIPT = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--config") { process.exit(3); }
  if (!raw.endsWith("\\n") || raw.slice(0, -1).includes("\\n")) { process.exit(4); }
  let req;
  try { req = JSON.parse(raw); } catch { process.exit(5); }
  if (req.v !== 1 || typeof req.op !== "string") { process.exit(6); }
  const res = { v: 1, ok: true, code: "OK", message: "ok", data: { echo: req.op }, deduplicated: false };
  process.stdout.write(JSON.stringify(res) + "\\n");
});
`;

// Strict-argv variant: exits 7 unless argv is exactly [entry, --config, config].
const STRICT_ARGV_SCRIPT = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const expectedEntry = process.env.EXPECT_ENTRY;
  const expectedConfig = process.env.EXPECT_CONFIG;
  const argv = process.argv.slice(1);
  if (argv.length !== 3 || argv[0] !== expectedEntry || argv[1] !== "--config" || argv[2] !== expectedConfig) {
    process.stderr.write("argv mismatch: " + JSON.stringify(argv) + "\\n");
    process.exit(7);
  }
  const res = { v: 1, ok: true, code: "OK", message: "ok", data: null, deduplicated: false };
  process.stdout.write(JSON.stringify(res) + "\\n");
});
`;

describe("memory CLI client", () => {
  it("spawns with exact argv/stdin and parses the envelope", async () => {
    const dir = tempDir();
    const entry = writeScript(dir, "ok.mjs", ENVELOPE_SCRIPT);
    const address = addressOf(entry);
    const envelope = await callMemoryCli(
      address,
      "record.recall",
      { query: "hello", scope: "s", runId: "r", limit: 5 },
      undefined,
    );
    expect(envelope).toEqual({
      ok: true,
      code: "OK",
      data: { echo: "record.recall" },
      deduplicated: false,
    });
  });

  it("uses shell:false with exactly [entry, --config, config]", async () => {
    const dir = tempDir();
    const entry = writeScript(dir, "strict.mjs", STRICT_ARGV_SCRIPT);
    const config = join(dir, "memory.config.json");
    writeFileSync(config, "{}", "utf-8");
    const address: MemoryCliAddress = {
      executable: process.execPath,
      entry,
      config,
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    };
    process.env.EXPECT_ENTRY = entry;
    process.env.EXPECT_CONFIG = config;
    try {
      const envelope = await callMemoryCli(
        address,
        "event.append",
        { probe: true },
        "test-key_1",
      );
      expect(envelope.ok).toBe(true);
    } finally {
      delete process.env.EXPECT_ENTRY;
      delete process.env.EXPECT_CONFIG;
    }
  });

  it("rejects unknown ops and key misuse without spawning", async () => {
    const dir = tempDir();
    const entry = writeScript(dir, "never.mjs", `process.exit(9);`);
    const address = addressOf(entry);
    await expect(
      callMemoryCli(address, "record.delete", {}, undefined),
    ).rejects.toMatchObject({ cliCode: "cli_bad_request" });
    await expect(
      callMemoryCli(address, "event.append", {}, undefined),
    ).rejects.toMatchObject({ cliCode: "cli_bad_request" });
    await expect(
      callMemoryCli(address, "record.recall", {}, "unexpected-key"),
    ).rejects.toMatchObject({ cliCode: "cli_bad_request" });
  });

  it("rejects oversize requests before spawn", async () => {
    const dir = tempDir();
    const entry = writeScript(dir, "never.mjs", `process.exit(9);`);
    const address = addressOf(entry);
    await expect(
      callMemoryCli(
        address,
        "record.recall",
        { query: "x".repeat(40000) },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: "cli_limit" });
  });

  it("maps malformed stdout to cli_malformed", async () => {
    const dir = tempDir();
    const cases: Array<[string, string]> = [
      ["not-json", `process.stdin.resume(); process.stdout.write("hello\\n");`],
      [
        "two-lines",
        `process.stdin.resume(); process.stdout.write("{}\\n{}\\n");`,
      ],
      [
        "no-trailing-lf",
        `process.stdin.resume(); process.stdout.write(JSON.stringify({v:1,ok:true,code:"OK",message:"ok",data:null,deduplicated:false}));`,
      ],
      [
        "unknown-code",
        `process.stdin.resume(); process.stdout.write(JSON.stringify({v:1,ok:false,code:"NOPE",message:"x",data:null,deduplicated:false}) + "\\n");`,
      ],
      [
        "extra-key",
        `process.stdin.resume(); process.stdout.write(JSON.stringify({v:1,ok:true,code:"OK",message:"ok",data:null,deduplicated:false,extra:1}) + "\\n");`,
      ],
    ];
    for (const [name, body] of cases) {
      const entry = writeScript(dir, `${name}.mjs`, body);
      await expect(
        callMemoryCli(
          addressOf(entry),
          "record.recall",
          { query: "q" },
          undefined,
        ),
      ).rejects.toMatchObject({ cliCode: "cli_malformed" });
    }
  });

  it("caps stdout at maxResponseBytes", async () => {
    const dir = tempDir();
    const entry = writeScript(
      dir,
      "big.mjs",
      `process.stdin.resume(); process.stdout.write(JSON.stringify({v:1,ok:true,code:"OK",message:"ok",data:{pad:"x".repeat(9000)},deduplicated:false}) + "\\n");`,
    );
    await expect(
      callMemoryCli(
        addressOf(entry, { maxResponseBytes: 4096 }),
        "record.recall",
        {
          query: "q",
        },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: "cli_limit" });
  });

  it("maps silent non-zero exits to cli_unavailable", async () => {
    const dir = tempDir();
    const entry = writeScript(
      dir,
      "silent.mjs",
      `process.stdin.resume(); process.stderr.write("error: store unavailable\\n"); process.exit(3);`,
    );
    await expect(
      callMemoryCli(
        addressOf(entry),
        "record.recall",
        { query: "q" },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: "cli_unavailable" });
  });

  it("ignores stderr when stdout is valid", async () => {
    const dir = tempDir();
    const entry = writeScript(
      dir,
      "noisy.mjs",
      `process.stdin.resume(); process.stderr.write("noise\\n".repeat(100)); process.stdout.write(JSON.stringify({v:1,ok:true,code:"OK",message:"ok",data:null,deduplicated:false}) + "\\n");`,
    );
    const envelope = await callMemoryCli(
      addressOf(entry),
      "record.recall",
      { query: "q" },
      undefined,
    );
    expect(envelope.ok).toBe(true);
  });

  it("kills a hanging child on timeout with no orphan", async () => {
    const dir = tempDir();
    const entry = writeScript(
      dir,
      "hang.mjs",
      `process.stdin.resume(); setTimeout(() => {}, 30000);`,
    );
    const started = Date.now();
    await expect(
      callMemoryCli(
        addressOf(entry, { timeoutMs: 200 }),
        "record.recall",
        {
          query: "q",
        },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: "cli_timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    // The reaped child accepts a fresh call immediately (no orphan held).
    const okEntry = writeScript(dir, "ok.mjs", ENVELOPE_SCRIPT);
    const envelope = await callMemoryCli(
      addressOf(okEntry),
      "record.recall",
      { query: "q" },
      undefined,
    );
    expect(envelope.ok).toBe(true);
  });

  it("aborts a hanging child on signal", async () => {
    const dir = tempDir();
    const entry = writeScript(
      dir,
      "hang.mjs",
      `process.stdin.resume(); setTimeout(() => {}, 30000);`,
    );
    const controller = new AbortController();
    const pending = callMemoryCli(
      addressOf(entry, { timeoutMs: 30000 }),
      "record.recall",
      { query: "q" },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ cliCode: "cli_timeout" });
  });

  it("settles an early-exit child without hanging on stdin", async () => {
    const dir = tempDir();
    const entry = writeScript(dir, "exit-early.mjs", `process.exit(0);`);
    await expect(
      callMemoryCli(
        addressOf(entry),
        "record.recall",
        { query: "q" },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: expect.any(String) });
    // The stdio/promise settled: a fresh call still works (no stuck state).
    const okEntry = writeScript(dir, "ok.mjs", ENVELOPE_SCRIPT);
    const envelope = await callMemoryCli(
      addressOf(okEntry),
      "record.recall",
      { query: "q" },
      undefined,
    );
    expect(envelope.ok).toBe(true);
  });

  it("settles an EPIPE stdin failure only after the child close (no orphan)", async () => {
    // Actual child lifetime proof: the real stub records its pid, destroys
    // stdin, then exits promptly. The test blocks the loop so the child is
    // fully gone (read end closed) before the queued parent write flushes,
    // making EPIPE deterministic: a small write to a sleeping child with a
    // merely-destroyed stdin still fits the pipe buffer and never errors.
    // Settlement must observe the close reap: when the call rejects, the
    // child is already reaped (kill(pid, 0) throws) instead of merely
    // signalled-but-alive.
    const dir = tempDir();
    const pidFile = join(dir, "child.pid");
    const entry = writeScript(
      dir,
      "epipe.mjs",
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.destroy();
setTimeout(() => process.exit(3), 100);`,
    );
    const pending = callMemoryCli(
      addressOf(entry, { timeoutMs: 10000 }),
      "record.recall",
      { query: "q" },
      undefined,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    await expect(pending).rejects.toMatchObject({
      cliCode: "cli_unavailable",
    });
    const pid = Number(readFileSync(pidFile, "utf-8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // Reaped, not orphaned: settling before the close reap would leave the
    // sleeping child alive here.
    expect(() => process.kill(pid, 0)).toThrow();
    // The reaped stdio accepts a fresh call (no orphan held).
    const okEntry = writeScript(dir, "ok.mjs", ENVELOPE_SCRIPT);
    const envelope = await callMemoryCli(
      addressOf(okEntry),
      "record.recall",
      { query: "q" },
      undefined,
    );
    expect(envelope.ok).toBe(true);
  });

  it("settles a spawn failure after the close reap (never hangs)", async () => {
    // Nonexistent executable: the `error` event records the failure and the
    // `close` reap settles it (the process never existed, so no orphan can
    // survive; the call still rejects instead of hanging).
    await expect(
      callMemoryCli(
        {
          executable: "/nonexistent-companion-memory-cli",
          entry: "/cli.js",
          config: join(tempDir(), "memory.config.json"),
          timeoutMs: 5000,
          maxResponseBytes: 65536,
        },
        "record.recall",
        { query: "q" },
        undefined,
      ),
    ).rejects.toMatchObject({ cliCode: "cli_unavailable" });
  });
});

describe("parseMemoryCliStdout", () => {
  it("accepts the exact envelope and rejects shape drift", () => {
    const good = Buffer.from(
      `${JSON.stringify({ v: 1, ok: false, code: "CONFLICT", message: "conflict", data: null, deduplicated: false })}\n`,
      "utf8",
    );
    expect(parseMemoryCliStdout(good, 65536)).toEqual({
      ok: false,
      code: "CONFLICT",
      data: null,
      deduplicated: false,
    });
    expect(() => parseMemoryCliStdout(Buffer.from("", "utf8"), 65536)).toThrow(
      MemoryCliError,
    );
    expect(() =>
      parseMemoryCliStdout(Buffer.from("{}\n extra\n", "utf8"), 65536),
    ).toThrow(MemoryCliError);
  });

  it("maps a foreign numeric response version to cli_version_mismatch", () => {
    const foreign = Buffer.from(
      `${JSON.stringify({ v: 2, ok: true, code: "OK", data: null, deduplicated: false })}\n`,
      "utf8",
    );
    try {
      parseMemoryCliStdout(foreign, 65536);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryCliError);
      expect((error as MemoryCliError).cliCode).toBe("cli_version_mismatch");
    }
  });

  it("maps the fixed unsupported-version BAD_REQUEST to cli_version_mismatch", () => {
    const reject = Buffer.from(
      `${JSON.stringify({
        v: 1,
        ok: false,
        code: "BAD_REQUEST",
        message: "unsupported protocol version",
        data: null,
        deduplicated: false,
      })}\n`,
      "utf8",
    );
    try {
      parseMemoryCliStdout(reject, 65536);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryCliError);
      expect((error as MemoryCliError).cliCode).toBe("cli_version_mismatch");
    }
  });

  it("maps a missing/non-numeric response version to cli_malformed", () => {
    for (const body of [
      { ok: true, code: "OK", data: null, deduplicated: false },
      { v: "1", ok: true, code: "OK", data: null, deduplicated: false },
    ]) {
      try {
        parseMemoryCliStdout(
          Buffer.from(`${JSON.stringify(body)}\n`, "utf8"),
          65536,
        );
        expect.unreachable("must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryCliError);
        expect((error as MemoryCliError).cliCode).toBe("cli_malformed");
      }
    }
  });
});
