// Slice (b) remote login/session tests (design §3).
//
// Covers: fail-closed config (step 0), password file guards + scrypt
// verification (step 1), login/logout sessions with cookie flags,
// uniform failures, global lockout, expiry/idle, hash-only storage,
// proxied-no-cookie rejection, X-Forwarded-* ignorance (steps 2-4),
// and disabled-mode regression (step 5). The enabled fixture uses the
// REAL scrypt password file + SQLite session store (same :memory: DB as
// the kernel) with an injectable clock.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CreatedServerApp,
  createApp,
  type RemotePasswordVerifier,
} from "../src/app.js";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import { readDefaultSecretPair, runSetPasswordCli } from "../src/cli.js";
import {
  DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
  DEFAULT_REMOTE_LOCKOUT_MS,
  DEFAULT_REMOTE_MAX_FAILURES,
  loadServerConfig,
  type RemoteConfig,
  ServerConfigError,
} from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  checkPasswordFileStat,
  createPasswordFileContent,
  loadRemotePasswordRecordSync,
  verifyPasswordAgainstRecord,
} from "../src/remote_password.js";
import {
  createSqliteRemoteSessionStore,
  hashRemoteToken,
  type RemoteSessionStore,
} from "../src/remote_session.js";

const ALLOWED_ORIGIN = "https://happy-meerkat.ts.net";
const ALLOWED_HOST = "happy-meerkat.ts.net";
const PASSWORD = "correct-horse-39-x";
const WRONG = "wrong-password-00";

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  db: Database.Database;
  store: RemoteSessionStore;
  passwordFile: string;
  setNow: (t: number) => void;
  close: () => void;
}

const T0 = 1790000000000;

function writePasswordFile(dir: string, password: string): string {
  const path = join(dir, "remote-pass.json");
  writeFileSync(path, createPasswordFileContent(password), { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
  return path;
}

async function makeAuthApp(
  overrides: Partial<RemoteConfig> = {},
): Promise<Fixture> {
  const scratch = mkdtempSync(join(tmpdir(), "companion-remote-auth-"));
  const passwordFile = writePasswordFile(scratch, PASSWORD);
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const base = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-remote-auth-db-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const remote: RemoteConfig = Object.freeze({
    enabled: true,
    allowedOrigins: Object.freeze([ALLOWED_ORIGIN]),
    passwordFile,
    absoluteTimeoutMs: DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
    maxFailures: DEFAULT_REMOTE_MAX_FAILURES,
    lockoutMs: DEFAULT_REMOTE_LOCKOUT_MS,
    ...overrides,
  });
  const config = Object.freeze({ ...base, remote });
  let nowValue = T0;
  const verifier: RemotePasswordVerifier = {
    verify: (password: string): boolean => {
      try {
        const record = loadRemotePasswordRecordSync(passwordFile);
        return verifyPasswordAgainstRecord(password, record);
      } catch {
        return false;
      }
    },
  };
  const store = createSqliteRemoteSessionStore(handle.raw);
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    now: () => nowValue,
    remoteStore: store,
    remotePassword: verifier,
  });
  return {
    ...created,
    repo,
    db: handle.raw,
    store,
    passwordFile,
    setNow: (t: number) => {
      nowValue = t;
    },
    close: () => closeKernelDatabase(handle),
  };
}

function loginHeaders(cookie?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    host: ALLOWED_HOST,
    origin: ALLOWED_ORIGIN,
    ...(cookie !== undefined ? { cookie } : {}),
  };
}

async function loginAs(
  f: Fixture,
  password: string,
): Promise<{
  status: number;
  cookie: string | null;
  setCookie: string | null;
}> {
  const res = await f.app.request("/api/remote/login", {
    method: "POST",
    headers: loginHeaders(),
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get("set-cookie");
  const pair = setCookie?.split(";")[0] ?? null;
  return {
    status: res.status,
    cookie: pair?.startsWith("companion_remote=") === true ? pair : null,
    setCookie,
  };
}

describe("remote auth config fail-closed (step 0)", () => {
  function baseEnv(): NodeJS.ProcessEnv {
    return {
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "companion-remote-authcfg-")),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "info",
    };
  }

  it("rejects unparseable remote JSON instead of silently disabling", () => {
    for (const raw of ["not-json", "{bad", "", "null", "42", '"x"']) {
      expect(
        () => loadServerConfig({ ...baseEnv(), COMPANION_REMOTE_JSON: raw }),
        raw,
      ).toThrow(ServerConfigError);
    }
  });

  it("leaves unset remote fully disabled with 案 defaults", () => {
    const config = loadServerConfig(baseEnv());
    expect(config.remote.enabled).toBe(false);
    expect(config.remote.passwordFile).toBeNull();
    expect(config.remote.absoluteTimeoutMs).toBe(
      DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
    );
    expect(config.remote.idleTimeoutMs).toBe(DEFAULT_REMOTE_IDLE_TIMEOUT_MS);
    expect(config.remote.maxFailures).toBe(DEFAULT_REMOTE_MAX_FAILURES);
    expect(config.remote.lockoutMs).toBe(DEFAULT_REMOTE_LOCKOUT_MS);
  });

  it("requires passwordFile when enabled and validates its shape", () => {
    expect(() =>
      loadServerConfig({
        ...baseEnv(),
        COMPANION_REMOTE_JSON: JSON.stringify({
          enabled: true,
          allowedOrigins: [ALLOWED_ORIGIN],
        }),
      }),
    ).toThrow(/password file/);
    expect(() =>
      loadServerConfig({
        ...baseEnv(),
        COMPANION_REMOTE_JSON: JSON.stringify({
          enabled: true,
          allowedOrigins: [ALLOWED_ORIGIN],
          passwordFile: "relative/path.json",
        }),
      }),
    ).toThrow(ServerConfigError);
    expect(() =>
      loadServerConfig({
        ...baseEnv(),
        COMPANION_REMOTE_JSON: JSON.stringify({
          enabled: true,
          allowedOrigins: [ALLOWED_ORIGIN],
          passwordFile: "/abs/pass.json",
          bogus: 1,
        }),
      }),
    ).toThrow(ServerConfigError);
  });

  it("refuses to compose an enabled app without session wiring", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const base = loadServerConfig({
        COMPANION_DB_PATH: join(
          mkdtempSync(join(tmpdir(), "companion-remote-authcfg-")),
          "db.sqlite",
        ),
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "3000",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "debug",
      });
      const { logger } = createCollectingLogger("debug");
      const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
      const config = Object.freeze({
        ...base,
        remote: Object.freeze({
          enabled: true,
          allowedOrigins: Object.freeze([ALLOWED_ORIGIN]),
          passwordFile: "/abs/pass.json",
          absoluteTimeoutMs: DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
          maxFailures: DEFAULT_REMOTE_MAX_FAILURES,
          lockoutMs: DEFAULT_REMOTE_LOCKOUT_MS,
        }),
      });
      expect(() => createApp({ config, repo, engine, logger })).toThrow(
        ServerConfigError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("password file (step 1)", () => {
  it("hashes with scrypt and verifies in constant time", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-pw-"));
    const path = writePasswordFile(dir, PASSWORD);
    const record = loadRemotePasswordRecordSync(path);
    expect(record.algo).toBe("scrypt");
    expect(verifyPasswordAgainstRecord(PASSWORD, record)).toBe(true);
    expect(verifyPasswordAgainstRecord(WRONG, record)).toBe(false);
    expect(verifyPasswordAgainstRecord("", record)).toBe(false);
    // The file carries no plaintext password.
    const text = readFileSync(path, "utf-8");
    expect(text).not.toContain(PASSWORD);
  });

  it("refuses world-readable password files on POSIX", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-pwmode-"));
    const path = join(dir, "remote-pass.json");
    writeFileSync(path, createPasswordFileContent(PASSWORD), { mode: 0o644 });
    chmodSync(path, 0o644);
    if (process.platform === "win32") {
      expect(() => checkPasswordFileStat(path)).not.toThrow();
    } else {
      expect(() => checkPasswordFileStat(path)).toThrow(/permissions/);
      expect(() => loadRemotePasswordRecordSync(path)).toThrow(/permissions/);
    }
  });

  it("refuses missing/directory/malformed password files", () => {
    expect(() =>
      loadRemotePasswordRecordSync(
        join(tmpdir(), `no-such-${randomUUID()}.json`),
      ),
    ).toThrow(ServerConfigError);
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-pwbad-"));
    expect(() => loadRemotePasswordRecordSync(dir)).toThrow(ServerConfigError);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json", { mode: 0o600 });
    expect(() => loadRemotePasswordRecordSync(bad)).toThrow(ServerConfigError);
  });
});

describe("set-password CLI (step 1)", () => {
  function cliEnv(passwordFile: string): NodeJS.ProcessEnv {
    return {
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "companion-remote-cli-")),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_REMOTE_JSON: JSON.stringify({
        enabled: true,
        allowedOrigins: [ALLOWED_ORIGIN],
        passwordFile,
      }),
    };
  }

  it("writes a 0600 file the login path accepts (never via env/argv)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-cli-"));
    const passwordFile = join(dir, "remote-pass.json");
    const seen: string[] = [];
    const message = await runSetPasswordCli(
      ["set-password"],
      cliEnv(passwordFile),
      async (prompt: string) => {
        seen.push(prompt);
        return "cli-password-1";
      },
    );
    expect(message).toBe("password updated");
    expect(seen).toEqual(["New password: ", "Confirm password: "]);
    const record = loadRemotePasswordRecordSync(passwordFile);
    expect(verifyPasswordAgainstRecord("cli-password-1", record)).toBe(true);
    expect(verifyPasswordAgainstRecord("cli-password-2", record)).toBe(false);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(passwordFile).mode & 0o077).toBe(0);
    }
  });

  it("rejects mismatched confirmations, weak passwords, and argv secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-cli-"));
    const passwordFile = join(dir, "remote-pass.json");
    let call = 0;
    await expect(
      runSetPasswordCli(["set-password"], cliEnv(passwordFile), async () => {
        call += 1;
        return call === 1 ? "first-password-1" : "second-password-2";
      }),
    ).rejects.toThrow(/do not match/);
    await expect(
      runSetPasswordCli(
        ["set-password"],
        cliEnv(passwordFile),
        async () => "short",
      ),
    ).rejects.toThrow();
    // Secrets never ride argv: any extra argument is rejected.
    await expect(
      runSetPasswordCli(
        ["set-password", "secret-on-argv"],
        cliEnv(passwordFile),
        async () => "cli-password-1",
      ),
    ).rejects.toThrow();
    await expect(
      runSetPasswordCli(["bogus"], cliEnv(passwordFile), async () => "x"),
    ).rejects.toThrow();
  });

  it("reads both piped confirmations through one interface", async () => {
    // Regression: two per-prompt readline interfaces lose the second
    // piped line (the first buffers the whole pipe). One shared
    // interface preserves it.
    const input = Readable.from(["piped-password-1\npiped-password-1\n"]);
    const nullOutput = new (await import("node:stream")).Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const [first, second] = await readDefaultSecretPair(
      input as unknown as NodeJS.ReadableStream,
      nullOutput as unknown as NodeJS.WritableStream,
    );
    expect(first).toBe("piped-password-1");
    expect(second).toBe("piped-password-1");
  });
});

describe("login sessions (steps 2-4)", () => {
  it("rejects unauthenticated API/SSE but keeps /health/live open", async () => {
    const f = await makeAuthApp();
    try {
      const live = await f.app.request("/health/live", {
        headers: { host: ALLOWED_HOST },
      });
      expect(live.status).toBe(200);
      const ready = await f.app.request("/health/ready", {
        headers: { host: ALLOWED_HOST },
      });
      expect(ready.status).toBe(401);
      const created = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...loginHeaders(),
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(created.status).toBe(401);
      expect(await created.json()).toEqual({
        error: { code: "unauthenticated", message: "authentication required" },
      });
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      const runId = f.repo.postMessage(
        sessionId,
        { text: "hi", uiContext: {} },
        { key: randomUUID(), now: T0, timeZone: "UTC" },
      );
      void runId;
      const runs = f.db.prepare("SELECT id FROM runs LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (runs !== undefined) {
        const sse = await f.app.request(
          `/api/sessions/${sessionId}/runs/${runs.id}/events/stream`,
          { headers: { host: ALLOWED_HOST, origin: ALLOWED_ORIGIN } },
        );
        expect(sse.status).toBe(401);
      }
      // The UI serves the script-free login form while unauthenticated
      // (slice (c): only the shared self-hosted stylesheet, no script).
      const page = await f.app.request("/", {
        headers: { host: ALLOWED_HOST },
      });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("<form");
      expect(html).toContain('action="/api/remote/login"');
      expect(html).toContain('href="/assets/client.css"');
      expect(html).not.toContain("/assets/client.js");
      expect(html.toLowerCase()).not.toContain("<script");
    } finally {
      f.close();
    }
  });

  it("login success sets cookie flags; API/SSE/ready open with it", async () => {
    const f = await makeAuthApp();
    try {
      const out = await loginAs(f, PASSWORD);
      expect(out.status).toBe(200);
      expect(out.cookie).toMatch(/^companion_remote=[0-9a-f]{64}$/);
      expect(out.setCookie).toContain("Path=/");
      expect(out.setCookie).toContain("HttpOnly");
      expect(out.setCookie).toContain("Secure");
      expect(out.setCookie).toContain("SameSite=Strict");
      const cookie = out.cookie as string;
      const ready = await f.app.request("/health/ready", {
        headers: { host: ALLOWED_HOST, cookie },
      });
      expect(ready.status).toBe(200);
      const created = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...loginHeaders(cookie),
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(created.status).toBe(201);
      const page = await f.app.request("/", {
        headers: { host: ALLOWED_HOST, cookie },
      });
      expect((await page.text()).toLowerCase()).toContain("/assets/client.js");
    } finally {
      f.close();
    }
  });

  it("wrong password answers the uniform error (no enumeration)", async () => {
    const f = await makeAuthApp();
    try {
      for (const attempt of [WRONG, "", "x"]) {
        const out = await loginAs(f, attempt);
        expect(out.status).toBe(401);
        expect(out.cookie).toBeNull();
      }
      // All three failures share the exact body.
      const res = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: loginHeaders(),
        body: JSON.stringify({ password: WRONG }),
      });
      expect(await res.json()).toEqual({
        error: { code: "invalid_credentials", message: "invalid credentials" },
      });
    } finally {
      f.close();
    }
  });

  it("locks out globally after maxFailures and recovers after lockoutMs", async () => {
    const f = await makeAuthApp({ maxFailures: 3, lockoutMs: 60_000 });
    try {
      for (let i = 0; i < 3; i += 1) {
        expect((await loginAs(f, WRONG)).status).toBe(401);
      }
      // The global counter (not IP-keyed) now locks every attempt.
      const locked = await loginAs(f, WRONG);
      expect(locked.status).toBe(429);
      expect(
        await (
          await f.app.request("/api/remote/login", {
            method: "POST",
            headers: loginHeaders(),
            body: JSON.stringify({ password: PASSWORD }),
          })
        ).json(),
      ).toEqual({
        error: { code: "rate_limited", message: "too many attempts" },
      });
      // After the lockout window a correct password succeeds again.
      f.setNow(T0 + 61_000);
      const ok = await loginAs(f, PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.cookie).not.toBeNull();
    } finally {
      f.close();
    }
  });

  it("logout invalidates the session and clears the cookie", async () => {
    const f = await makeAuthApp();
    try {
      const cookie = (await loginAs(f, PASSWORD)).cookie as string;
      const out = await f.app.request("/api/remote/logout", {
        method: "POST",
        headers: {
          ...loginHeaders(cookie),
        },
        body: "{}",
      });
      expect(out.status).toBe(200);
      expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
      const reuse = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...loginHeaders(cookie),
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(reuse.status).toBe(401);
      // The row is gone from SQLite (not merely flagged).
      const token = cookie.split("=")[1] as string;
      expect(f.store.lookup(hashRemoteToken(token))).toBeNull();
    } finally {
      f.close();
    }
  });

  it("rejects expired and idle sessions", async () => {
    const f = await makeAuthApp({
      absoluteTimeoutMs: 3_600_000,
      idleTimeoutMs: 900_000,
    });
    try {
      const cookie = (await loginAs(f, PASSWORD)).cookie as string;
      // Stay inside the idle window with touches until just before the
      // absolute deadline (each hop is shorter than the idle timeout).
      for (const t of [
        T0 + 800_000,
        T0 + 1_600_000,
        T0 + 2_400_000,
        T0 + 3_200_000,
      ]) {
        f.setNow(t);
        expect(
          (
            await f.app.request("/health/ready", {
              headers: { host: ALLOWED_HOST, cookie },
            })
          ).status,
        ).toBe(200);
      }
      // Absolute expiry wins even with recent activity.
      f.setNow(T0 + 3_600_000);
      expect(
        (
          await f.app.request("/health/ready", {
            headers: { host: ALLOWED_HOST, cookie },
          })
        ).status,
      ).toBe(401);
      // Fresh login, then idle past the idle timeout.
      f.setNow(T0);
      const cookie2 = (await loginAs(f, PASSWORD)).cookie as string;
      f.setNow(T0 + 901_000);
      expect(
        (
          await f.app.request("/health/ready", {
            headers: { host: ALLOWED_HOST, cookie: cookie2 },
          })
        ).status,
      ).toBe(401);
      // Activity refreshes the idle window: touch then stay inside it.
      f.setNow(T0);
      const cookie3 = (await loginAs(f, PASSWORD)).cookie as string;
      f.setNow(T0 + 800_000);
      expect(
        (
          await f.app.request("/health/ready", {
            headers: { host: ALLOWED_HOST, cookie: cookie3 },
          })
        ).status,
      ).toBe(200);
      f.setNow(T0 + 1_600_000);
      expect(
        (
          await f.app.request("/health/ready", {
            headers: { host: ALLOWED_HOST, cookie: cookie3 },
          })
        ).status,
      ).toBe(200);
    } finally {
      f.close();
    }
  });

  it("stores only the token hash (never the token)", async () => {
    const f = await makeAuthApp();
    try {
      const cookie = (await loginAs(f, PASSWORD)).cookie as string;
      const token = cookie.split("=")[1] as string;
      const rows = f.db
        .prepare("SELECT token_hash FROM remote_sessions")
        .all() as { token_hash: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toBe(hashRemoteToken(token));
      // The raw token appears nowhere in the table.
      const dump = f.db
        .prepare("SELECT sql FROM sqlite_master WHERE name='remote_sessions'")
        .get() as { sql: string };
      expect(dump.sql).not.toContain(token);
      const raw = (
        f.db.prepare("SELECT * FROM remote_sessions").all() as Record<
          string,
          unknown
        >[]
      ).map((row) => JSON.stringify(row));
      expect(raw.join("")).not.toContain(token);
    } finally {
      f.close();
    }
  });

  it("rejects proxied-from-127.0.0.1 requests without a cookie and ignores X-Forwarded-*", async () => {
    const f = await makeAuthApp();
    try {
      // A proxy forward cannot smuggle trust: no cookie, no entry —
      // even with forwarding headers claiming an allowed host/proto/ip.
      const bare = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...loginHeaders(),
          "idempotency-key": randomUUID(),
          "x-forwarded-host": ALLOWED_HOST,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "127.0.0.1",
        },
        body: "{}",
      });
      expect(bare.status).toBe(401);
      // And forwarding headers cannot widen the Host/Origin decision.
      const spoofed = await f.app.request("/health/live", {
        headers: {
          host: "evil.example",
          "x-forwarded-host": ALLOWED_HOST,
          "x-forwarded-proto": "https",
        },
      });
      expect(spoofed.status).toBe(400);
    } finally {
      f.close();
    }
  });

  it("accepts the no-asset urlencoded login form (303 to the app)", async () => {
    const f = await makeAuthApp();
    try {
      const res = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: ALLOWED_HOST,
          origin: ALLOWED_ORIGIN,
        },
        body: `password=${encodeURIComponent(PASSWORD)}`,
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toContain("companion_remote=");
      // The redirect target serves the app shell once authenticated.
      const cookie = (
        res.headers.get("set-cookie")?.split(";")[0] ?? ""
      ).trim();
      const page = await f.app.request("/", {
        headers: { host: ALLOWED_HOST, cookie },
      });
      expect((await page.text()).toLowerCase()).toContain("/assets/client.js");
    } finally {
      f.close();
    }
  });

  it("keeps the JSON login response for API clients", async () => {
    const f = await makeAuthApp();
    try {
      const res = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: loginHeaders(),
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      f.close();
    }
  });
});

describe("remote bootstrap over HTTP (step 4)", () => {
  const servers: StartedServer[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.shutdown("test-teardown");
      }
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  function remoteEnv(passwordFile: string): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-boot-"));
    dirs.push(dir);
    return {
      COMPANION_DB_PATH: join(dir, "companion.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_REMOTE_JSON: JSON.stringify({
        enabled: true,
        allowedOrigins: [ALLOWED_ORIGIN],
        passwordFile,
      }),
    };
  }

  it("starts with a valid password file and enforces sessions", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "companion-remote-bootpw-"));
    dirs.push(scratch);
    const passwordFile = writePasswordFile(scratch, PASSWORD);
    const started = await startServer({ env: remoteEnv(passwordFile) });
    servers.push(started);
    const base = `http://127.0.0.1:${started.port}`;
    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
      status: "live",
    });
    // No cookie: API + ready rejected, login form served. (Real fetch
    // sends `sec-fetch-mode`, so the POSTs carry the allowed Origin
    // exactly as a browser would; without it they are browser-like 403s.)
    expect(await (await fetch(`${base}/health/ready`)).status).toBe(401);
    expect(
      await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            origin: ALLOWED_ORIGIN,
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const form = await (await fetch(`${base}/`)).text();
    expect(form).toContain('action="/api/remote/login"');
    // Login, then the cookie opens the API.
    const login = await fetch(`${base}/api/remote/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = (setCookie.split(";")[0] ?? "").trim();
    expect(cookie).toMatch(/^companion_remote=[0-9a-f]{64}$/);
    expect(
      await (
        await fetch(`${base}/health/ready`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            origin: ALLOWED_ORIGIN,
            cookie,
          },
          body: "{}",
        })
      ).status,
    ).toBe(201);
  });

  it("fails startup when the password file is missing", async () => {
    const missDir = mkdtempSync(join(tmpdir(), "companion-remote-bootmiss-"));
    dirs.push(missDir);
    const missing = join(missDir, "remote-pass.json");
    await expect(startServer({ env: remoteEnv(missing) })).rejects.toThrow(
      ServerConfigError,
    );
  });
});

describe("login form body bounds (review finding)", () => {
  it("rejects oversized urlencoded login bodies without buffering", async () => {
    const f = await makeAuthApp();
    try {
      const formHeaders = {
        "content-type": "application/x-www-form-urlencoded",
        host: ALLOWED_HOST,
        origin: ALLOWED_ORIGIN,
      };
      // Declared length over the 8 KiB cap: rejected outright.
      const huge = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: { ...formHeaders, "content-length": "1000000" },
        body: `password=${encodeURIComponent(PASSWORD)}`,
      });
      expect(huge.status).toBe(400);
      // Actually-over-cap chunked body: streamed, cancelled, rejected.
      const over = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: formHeaders,
        body: `password=${"x".repeat(9000)}`,
      });
      expect(over.status).toBe(400);
      expect(over.headers.get("set-cookie")).toBeNull();
      // Malformed Content-Length fails closed.
      const malformed = await f.app.request("/api/remote/login", {
        method: "POST",
        headers: { ...formHeaders, "content-length": "many" },
        body: `password=${encodeURIComponent(PASSWORD)}`,
      });
      expect(malformed.status).toBe(400);
    } finally {
      f.close();
    }
  });
});

describe("disabled remote regression (step 5)", () => {
  it("serves everything without login and exposes no remote routes", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const config = loadServerConfig({
        COMPANION_DB_PATH: join(
          mkdtempSync(join(tmpdir(), "companion-remote-off-")),
          "db.sqlite",
        ),
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "3000",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "debug",
      });
      const { logger } = createCollectingLogger("debug");
      const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
      const created = createApp({ config, repo, engine, logger });
      try {
        const live = await created.app.request("/health/live", {
          headers: { host: "127.0.0.1" },
        });
        expect(live.status).toBe(200);
        const ready = await created.app.request("/health/ready", {
          headers: { host: "127.0.0.1" },
        });
        expect(ready.status).toBe(200);
        const made = await created.app.request("/api/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "127.0.0.1",
            "idempotency-key": randomUUID(),
          },
          body: "{}",
        });
        expect(made.status).toBe(201);
        // No login surface while disabled.
        const login = await created.app.request("/api/remote/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "127.0.0.1",
          },
          body: JSON.stringify({ password: PASSWORD }),
        });
        expect(login.status).toBe(404);
        const page = await created.app.request("/", {
          headers: { host: "127.0.0.1" },
        });
        expect((await page.text()).toLowerCase()).toContain(
          "/assets/client.js",
        );
      } finally {
        closeKernelDatabase(handle);
      }
    } finally {
      // closed above
    }
  });
});

describe("set-password target guard (review finding)", () => {
  function guardCliEnv(passwordFile: string): NodeJS.ProcessEnv {
    return {
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "companion-remote-guard-")),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_REMOTE_JSON: JSON.stringify({
        enabled: true,
        allowedOrigins: [ALLOWED_ORIGIN],
        passwordFile,
      }),
    };
  }

  it("refuses to overwrite unrelated, symlink, or DB targets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-guard-"));
    const reader = async () => "cli-password-1";
    // Junk content (e.g. a mispointed DB path) is left intact.
    const junk = join(dir, "not-a-password.json");
    writeFileSync(junk, "sqlite format 3\0junk-junk-junk");
    await expect(
      runSetPasswordCli(["set-password"], guardCliEnv(junk), reader),
    ).rejects.toThrow(/^set password failed$/);
    expect(readFileSync(junk, "utf-8")).toBe("sqlite format 3\0junk-junk-junk");
    // Symlink targets are rejected even when pointing at a valid file.
    if (process.platform !== "win32") {
      const { symlinkSync } = await import("node:fs");
      const target = join(dir, "remote-pass.json");
      await runSetPasswordCli(["set-password"], guardCliEnv(target), reader);
      const link = join(dir, "link-pass.json");
      symlinkSync(target, link);
      await expect(
        runSetPasswordCli(["set-password"], guardCliEnv(link), reader),
      ).rejects.toThrow(/^set password failed$/);
      // Rotation over an existing VALID password file stays allowed.
      const rotated = await runSetPasswordCli(
        ["set-password"],
        guardCliEnv(target),
        reader,
      );
      expect(rotated).toBe("password updated");
    }
  });

  it("refuses a passwordFile equal to the DB path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-remote-guard-"));
    const dbPath = join(dir, "db.sqlite");
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_REMOTE_JSON: JSON.stringify({
        enabled: true,
        allowedOrigins: [ALLOWED_ORIGIN],
        passwordFile: dbPath,
      }),
    };
    await expect(
      runSetPasswordCli(["set-password"], env, async () => "cli-password-1"),
    ).rejects.toThrow(/^set password failed$/);
  });
});
