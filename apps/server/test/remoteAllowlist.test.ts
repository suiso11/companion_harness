// Slice (a) remote Origin/Host allowlist tests (default-off).
//
// Disabled remote must behave byte-identically to the historical loopback
// logic; enabled remote enforces the explicit allowlist for Host, mutation
// Origin, and GET/SSE reads. Auth (slice b) is enforced at startup, so the
// enabled app configs below are built by overriding the validated base
// config in-memory only (never via env).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import {
  loadServerConfig,
  parseRemoteConfig,
  type RemoteConfig,
  ServerConfigError,
} from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const ALLOWED_ORIGIN = "https://happy-meerkat.ts.net";
const ALLOWED_HOST = "happy-meerkat.ts.net";

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  close: () => void;
}

async function makeApp(remote: RemoteConfig | null): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const base = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-remote-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const config =
    remote === null
      ? base
      : Object.freeze({
          ...base,
          remote: Object.freeze({
            enabled: remote.enabled,
            allowedOrigins: Object.freeze([...remote.allowedOrigins]),
          }),
        });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return { ...created, repo, close: () => closeKernelDatabase(handle) };
}

function enabledRemote(): RemoteConfig {
  return { enabled: true, allowedOrigins: [ALLOWED_ORIGIN] };
}

async function createSessionId(f: Fixture): Promise<string> {
  return f.repo.createSession({ key: randomUUID(), now: 1790000000000 }).body
    .sessionId;
}

describe("remote disabled (default)", () => {
  it("keeps loopback behavior and rejects tailnet Host/Origin", async () => {
    const f = await makeApp(null);
    try {
      expect(f.app).toBeDefined();
      // Loopback still works.
      const live = await f.app.request("/health/live", {
        headers: { host: "127.0.0.1" },
      });
      expect(live.status).toBe(200);
      // Tailnet Host is rejected exactly like any non-loopback host.
      const tailHost = await f.app.request("/health/live", {
        headers: { host: ALLOWED_HOST },
      });
      expect(tailHost.status).toBe(400);
      // Tailnet Origin on a mutation is rejected.
      const evil = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          origin: ALLOWED_ORIGIN,
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(evil.status).toBe(403);
      // Reads ignore Origin while disabled (unchanged behavior).
      const sessionId = await createSessionId(f);
      const read = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        { headers: { host: "127.0.0.1", origin: "https://evil.example" } },
      );
      expect(read.status).toBe(200);
    } finally {
      f.close();
    }
  });
});

describe("remote enabled (allowlist)", () => {
  it("accepts allowed Host/Origin and keeps loopback working", async () => {
    const f = await makeApp(enabledRemote());
    try {
      const live = await f.app.request("/health/live", {
        headers: { host: ALLOWED_HOST },
      });
      expect(live.status).toBe(200);
      const loopback = await f.app.request("/health/live", {
        headers: { host: "127.0.0.1" },
      });
      expect(loopback.status).toBe(200);
      const sessionId = await createSessionId(f);
      const created = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: ALLOWED_HOST,
          origin: ALLOWED_ORIGIN,
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("access-control-allow-origin")).toBeNull();
      // Loopback same-origin mutation still passes.
      const local = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(local.status).toBe(201);
      // Allowed GET read passes with the allowlisted Origin.
      const read = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        { headers: { host: ALLOWED_HOST, origin: ALLOWED_ORIGIN } },
      );
      expect(read.status).toBe(200);
      void sessionId;
    } finally {
      f.close();
    }
  });

  it("rejects unknown Host, bad Origin, null Origin, and cross-site GET", async () => {
    const f = await makeApp(enabledRemote());
    try {
      const badHost = await f.app.request("/health/live", {
        headers: { host: "evil.example" },
      });
      expect(badHost.status).toBe(400);
      const badOrigin = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: ALLOWED_HOST,
          origin: "https://evil.example",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(badOrigin.status).toBe(403);
      const nullOrigin = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: ALLOWED_HOST,
          origin: "null",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(nullOrigin.status).toBe(403);
      const sessionId = await createSessionId(f);
      const crossGet = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        {
          headers: { host: ALLOWED_HOST, origin: "https://evil.example" },
        },
      );
      expect(crossGet.status).toBe(403);
      const nullGet = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        { headers: { host: ALLOWED_HOST, origin: "null" } },
      );
      expect(nullGet.status).toBe(403);
      const fetchSite = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        {
          headers: { host: ALLOWED_HOST, "sec-fetch-site": "cross-site" },
        },
      );
      expect(fetchSite.status).toBe(403);
      // Same-origin GET without Origin stays normal.
      const sameOrigin = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        {
          headers: { host: ALLOWED_HOST, "sec-fetch-site": "same-origin" },
        },
      );
      expect(sameOrigin.status).toBe(200);
      const noMetadata = await f.app.request(
        `/api/sessions/${sessionId}/active-run`,
        { headers: { host: ALLOWED_HOST } },
      );
      expect(noMetadata.status).toBe(200);
    } finally {
      f.close();
    }
  });

  it("ignores X-Forwarded-Host for decisions", async () => {
    const f = await makeApp(enabledRemote());
    try {
      // A spoofed forwarding header cannot rescue an unknown Host.
      const spoofed = await f.app.request("/health/live", {
        headers: {
          host: "evil.example",
          "x-forwarded-host": ALLOWED_HOST,
          "x-forwarded-proto": "https",
        },
      });
      expect(spoofed.status).toBe(400);
      // And a forwarding header cannot smuggle an Origin past the check.
      const smuggled = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "evil.example",
          origin: ALLOWED_ORIGIN,
          "x-forwarded-host": ALLOWED_HOST,
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(smuggled.status).toBe(400);
    } finally {
      f.close();
    }
  });
});

describe("remote config fail-closed", () => {
  function baseEnv(dbSuffix: string): NodeJS.ProcessEnv {
    return {
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), `companion-remote-cfg-${dbSuffix}-`)),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "info",
    };
  }

  it("defaults to disabled with an empty allowlist", () => {
    const config = loadServerConfig(baseEnv("default"));
    expect(config.remote.enabled).toBe(false);
    expect(config.remote.allowedOrigins).toEqual([]);
    expect(Object.isFrozen(config.remote)).toBe(true);
  });

  it("rejects enabled remote with an empty allowlist", () => {
    for (const raw of [
      '{"enabled":true}',
      '{"enabled":true,"allowedOrigins":[]}',
    ]) {
      expect(() =>
        loadServerConfig({
          ...baseEnv("empty"),
          COMPANION_REMOTE_JSON: raw,
        }),
      ).toThrow(ServerConfigError);
    }
  });

  it("requires authentication while slice (b) is unavailable", () => {
    expect(() =>
      loadServerConfig({
        ...baseEnv("auth"),
        COMPANION_REMOTE_JSON: JSON.stringify({
          enabled: true,
          allowedOrigins: [ALLOWED_ORIGIN],
        }),
      }),
    ).toThrow(/requires authentication/);
  });

  it("rejects malformed origins and shapes", () => {
    const bad = [
      "not-json",
      "[]",
      '{"enabled":"yes"}',
      '{"enabled":false,"bogus":1}',
      `{"enabled":false,"allowedOrigins":["http://127.0.0.1:3000"]}`,
      `{"enabled":false,"allowedOrigins":["${ALLOWED_ORIGIN}/"]}`,
      `{"enabled":false,"allowedOrigins":["${ALLOWED_ORIGIN}/path"]}`,
      `{"enabled":false,"allowedOrigins":["${ALLOWED_ORIGIN}?x=1"]}`,
      `{"enabled":false,"allowedOrigins":["https://user@${ALLOWED_HOST}"]}`,
      `{"enabled":false,"allowedOrigins":["https://${ALLOWED_HOST}:8443"]}`,
      `{"enabled":false,"allowedOrigins":["${ALLOWED_ORIGIN}","${ALLOWED_ORIGIN}"]}`,
    ];
    for (const raw of bad) {
      expect(() => parseRemoteConfig(raw), raw).toThrow(ServerConfigError);
    }
    const ok = parseRemoteConfig(
      JSON.stringify({ enabled: false, allowedOrigins: [ALLOWED_ORIGIN] }),
    );
    expect(ok.enabled).toBe(false);
    expect(ok.allowedOrigins).toEqual([ALLOWED_ORIGIN]);
  });
});
