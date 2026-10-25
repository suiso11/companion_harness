// AGORA browser review HTTP API: real Hono app + real durable private store
// with an injected local transport. No public network, no production key/DB.
//
// Proves: auth/origin gate, session isolation (operator-created rows are
// invisible), exact-hash approve/reject, stale hash/status 409s, one-use
// send (sequential and concurrent), durable unknown terminal outcome,
// throttling, fixed destination/result URL, and no key/raw-body leakage.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGORA_MIN_WRITE_INTERVAL_MS,
  type AgoraTransport,
  closeKernelDatabase,
  createAgoraStore,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import {
  DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
  DEFAULT_REMOTE_LOCKOUT_MS,
  DEFAULT_REMOTE_MAX_FAILURES,
  loadServerConfig,
  type RemoteConfig,
} from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  createSqliteRemoteLoginRateLimiter,
  createSqliteRemoteSessionStore,
} from "../src/remote_session.js";

const T0 = 1_790_000_000_000;
const KEY = "agora-http-secret-key";
const ALLOWED_ORIGIN = "https://happy-meerkat.ts.net";
const ALLOWED_HOST = "happy-meerkat.ts.net";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

interface Hit {
  path: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}

type PostFn = (hit: Hit) => Promise<{ status: number; text: string }>;

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  store: ReturnType<typeof createAgoraStore>;
  hits: Hit[];
  setPost: (fn: PostFn) => void;
  now: () => number;
  advance: (ms: number) => void;
  close: () => void;
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

async function makeFixture(
  options: {
    remote?: boolean;
    agora?: boolean;
    hostApiKey?: string | null;
  } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "agora-http-"));
  cleanups.push(dir);
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  // The AGORA review routes require the session to exist; seed the two fixed
  // test sessions once so isolation tests exercise repository lookups.
  for (const id of [SESSION_A, SESSION_B]) {
    handle.raw
      .prepare(
        "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, 1)",
      )
      .run(id, T0, T0);
  }
  const base = loadServerConfig({
    COMPANION_DB_PATH: join(dir, "db.sqlite"),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const config =
    options.remote === true
      ? Object.freeze({
          ...base,
          remote: Object.freeze({
            enabled: true,
            allowedOrigins: Object.freeze([ALLOWED_ORIGIN]),
            passwordFile: join(dir, "remote-pass.json"),
            absoluteTimeoutMs: DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
            idleTimeoutMs: DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
            maxFailures: DEFAULT_REMOTE_MAX_FAILURES,
            lockoutMs: DEFAULT_REMOTE_LOCKOUT_MS,
          } satisfies RemoteConfig),
        })
      : base;
  let nowValue = T0;
  const hits: Hit[] = [];
  let postFn: PostFn = async (hit) =>
    hit.path === "/api/register"
      ? { status: 201, text: JSON.stringify({ api_key: KEY }) }
      : { status: 201, text: JSON.stringify({ threadId: "thread-verified" }) };
  const transport: AgoraTransport = {
    async get() {
      return { status: 200, contentType: "application/json", text: "{}" };
    },
    async post(path, body, headers) {
      const hit = { path, body, headers };
      hits.push(hit);
      return postFn(hit);
    },
  };
  const store = createAgoraStore({
    path: join(dir, "private", "agora.sqlite"),
    transport,
    clock: { now: () => nowValue },
    hostApiKey: options.hostApiKey === undefined ? KEY : options.hostApiKey,
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const remoteStore =
    options.remote === true ? createSqliteRemoteSessionStore(handle.raw) : null;
  const remoteLimiter =
    options.remote === true
      ? createSqliteRemoteLoginRateLimiter(handle.raw, {
          maxFailures: config.remote?.maxFailures ?? 1,
          lockoutMs: config.remote?.lockoutMs ?? 1000,
        })
      : null;
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    now: () => nowValue,
    ...(options.agora === false ? {} : { agora: store }),
    ...(remoteStore !== null && remoteLimiter !== null
      ? {
          remoteStore,
          remotePassword: { verify: () => false },
          remoteLoginLimiter: remoteLimiter,
        }
      : {}),
  });
  return {
    ...created,
    repo,
    store,
    hits,
    setPost(fn) {
      postFn = fn;
    },
    now: () => nowValue,
    advance(ms) {
      nowValue += ms;
    },
    close() {
      store.close();
      closeKernelDatabase(handle);
    },
  };
}

function headers(
  extra: Record<string, string> = {},
  remote = false,
): Record<string, string> {
  return {
    "content-type": "application/json",
    host: remote ? ALLOWED_HOST : "127.0.0.1",
    ...extra,
  };
}

async function get(
  f: Fixture,
  path: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await f.app.request(path, {
    method: "GET",
    headers: headers(),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as unknown, text };
}

async function post(
  f: Fixture,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
  remote = false,
): Promise<{
  status: number;
  body: unknown;
  text: string;
  retryAfter: string | null;
}> {
  const res = await f.app.request(path, {
    method: "POST",
    headers: headers(extra, remote),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as unknown,
    text,
    retryAfter: res.headers.get("retry-after"),
  };
}

function propose(
  f: Fixture,
  sessionId: string | null,
  title: string,
): ReturnType<typeof f.store.propose> {
  return f.store.propose({
    operation: "thread",
    payload: { title, body: `${title} body` },
    ...(sessionId === null ? {} : { sessionId }),
  });
}

function base(sessionId: string, proposalId: string, action: string): string {
  return `/api/sessions/${sessionId}/agora/proposals/${proposalId}${action}`;
}

describe("AGORA session review HTTP API", () => {
  it("fails closed without auth/origin and 404s when AGORA is disabled", async () => {
    const remote = await makeFixture({ remote: true });
    try {
      const proposal = propose(remote, SESSION_A, "Auth title");
      const unauth = await remote.app.request(
        `/api/sessions/${SESSION_A}/agora/proposals`,
        { method: "GET", headers: { host: ALLOWED_HOST } },
      );
      expect(unauth.status).toBe(401);
      const origin = await remote.app.request(
        base(SESSION_A, proposal.id, "/approve"),
        {
          method: "POST",
          headers: headers({ origin: "https://evil.example" }, true),
          body: JSON.stringify({ payloadHash: proposal.payloadHash }),
        },
      );
      expect(origin.status).toBe(403);
      expect(remote.hits).toHaveLength(0);
    } finally {
      remote.close();
    }

    const disabled = await makeFixture({ agora: false });
    try {
      const res = await get(
        disabled,
        `/api/sessions/${SESSION_A}/agora/proposals`,
      );
      expect(res.status).toBe(404);
      const send = await post(
        disabled,
        base(SESSION_A, randomUUID(), "/send"),
        { payloadHash: "0".repeat(64) },
      );
      expect(send.status).toBe(404);
    } finally {
      disabled.close();
    }
  });

  it("isolates other sessions and never exposes operator-created rows", async () => {
    const f = await makeFixture();
    try {
      const owned = propose(f, SESSION_A, "Owned title");
      const operator = propose(f, null, "Operator title");

      const listA = await get(f, `/api/sessions/${SESSION_A}/agora/proposals`);
      expect(listA.status).toBe(200);
      const listBody = listA.body as {
        proposals: Array<{ proposalId: string }>;
      };
      expect(listBody.proposals.map((row) => row.proposalId)).toEqual([
        owned.id,
      ]);

      const listB = await get(f, `/api/sessions/${SESSION_B}/agora/proposals`);
      expect((listB.body as { proposals: unknown[] }).proposals).toHaveLength(
        0,
      );
      expect((await get(f, base(SESSION_A, operator.id, ""))).status).toBe(404);
      expect((await get(f, base(SESSION_B, owned.id, ""))).status).toBe(404);
      expect(
        (
          await post(f, base(SESSION_B, owned.id, "/approve"), {
            payloadHash: owned.payloadHash,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(f, base(SESSION_A, operator.id, "/reject"), {
            payloadHash: operator.payloadHash,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(f, base(SESSION_A, operator.id, "/send"), {
            payloadHash: operator.payloadHash,
          })
        ).status,
      ).toBe(404);
      expect(f.hits).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("requires the exact hash for approve and renders the exact view", async () => {
    const f = await makeFixture();
    try {
      const owned = propose(f, SESSION_A, "Exact title");
      const shown = await get(f, base(SESSION_A, owned.id, ""));
      expect(shown.status).toBe(200);
      const view = (
        shown.body as {
          proposal: Record<string, unknown>;
        }
      ).proposal;
      expect(view).toMatchObject({
        proposalId: owned.id,
        operation: "thread",
        status: "pending",
        destination: "https://agora.grimoire-fio.workers.dev/api/threads",
        payloadHash: owned.payloadHash,
        title: "Exact title",
        body: "Exact title body",
        threadId: null,
        resultThreadId: null,
        resultUrl: null,
      });
      expect(shown.text).not.toContain(KEY);

      const wrong = await post(f, base(SESSION_A, owned.id, "/approve"), {
        payloadHash: "0".repeat(64),
      });
      expect(wrong.status).toBe(409);
      expect((wrong.body as { error: { code: string } }).error.code).toBe(
        "agora_payload_hash_mismatch",
      );
      expect(f.store.show(owned.id).status).toBe("pending");

      const approved = await post(f, base(SESSION_A, owned.id, "/approve"), {
        payloadHash: owned.payloadHash,
      });
      expect(approved.status).toBe(200);
      expect(
        (approved.body as { proposal: { status: string } }).proposal.status,
      ).toBe("approved");
      const repeat = await post(f, base(SESSION_A, owned.id, "/approve"), {
        payloadHash: owned.payloadHash,
      });
      expect(repeat.status).toBe(200);
      expect(f.store.show(owned.id).status).toBe("approved");
      expect(f.hits).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("binds reject to the exact hash and makes rejected unsendable", async () => {
    const f = await makeFixture();
    try {
      const owned = propose(f, SESSION_A, "Reject title");
      const stale = await post(f, base(SESSION_A, owned.id, "/reject"), {
        payloadHash: "0".repeat(64),
      });
      expect(stale.status).toBe(409);
      expect(f.store.show(owned.id).status).toBe("pending");

      const rejected = await post(f, base(SESSION_A, owned.id, "/reject"), {
        payloadHash: owned.payloadHash,
      });
      expect(rejected.status).toBe(200);
      expect(f.store.show(owned.id).status).toBe("rejected");
      const repeat = await post(f, base(SESSION_A, owned.id, "/reject"), {
        payloadHash: owned.payloadHash,
      });
      expect(repeat.status).toBe(200);

      const send = await post(f, base(SESSION_A, owned.id, "/send"), {
        payloadHash: owned.payloadHash,
      });
      expect(send.status).toBe(409);
      expect((send.body as { error: { code: string } }).error.code).toBe(
        "agora_proposal_state_conflict",
      );
      expect(f.hits).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("sends one exact approved proposal once, including concurrent clicks", async () => {
    const f = await makeFixture();
    try {
      const owned = propose(f, SESSION_A, "Send title");
      f.store.approve(owned.id, owned.payloadHash);
      const sent = await post(f, base(SESSION_A, owned.id, "/send"), {
        payloadHash: owned.payloadHash,
      });
      expect(sent.status).toBe(200);
      expect((sent.body as { outcome: string }).outcome).toBe("sent");
      expect(f.hits).toHaveLength(1);
      expect(f.hits[0]?.path).toBe("/api/threads");
      expect(f.hits[0]?.body).toEqual({
        title: "Send title",
        body: "Send title body",
      });
      const view = (
        sent.body as {
          proposal: {
            status: string;
            resultThreadId: string;
            resultUrl: string;
          };
        }
      ).proposal;
      expect(view.status).toBe("sent");
      expect(view.resultThreadId).toBe("thread-verified");
      expect(view.resultUrl).toBe(
        "https://agora.grimoire-fio.workers.dev/t/thread-verified",
      );
      expect(sent.text).not.toContain(KEY);

      const replay = await post(f, base(SESSION_A, owned.id, "/send"), {
        payloadHash: owned.payloadHash,
      });
      expect(replay.status).toBe(409);
      expect(f.hits).toHaveLength(1);

      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const second = propose(f, SESSION_A, "Concurrent title");
      f.store.approve(second.id, second.payloadHash);
      let release!: () => void;
      f.setPost(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                status: 201,
                text: JSON.stringify({
                  threadId: "thread-concurrent",
                  raw: "raw-provider-body-marker",
                }),
              });
          }),
      );
      const request = () =>
        post(f, base(SESSION_A, second.id, "/send"), {
          payloadHash: second.payloadHash,
        });
      const first = request();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const concurrent = await request();
      expect(concurrent.status).toBe(409);
      release();
      const won = await first;
      expect(won.status).toBe(200);
      expect((won.body as { outcome: string }).outcome).toBe("sent");
      expect(won.text).not.toContain("raw-provider-body-marker");
      expect(won.text).not.toContain(KEY);
      expect(f.hits).toHaveLength(2);
      const shown = await get(f, base(SESSION_A, second.id, ""));
      expect(shown.text).not.toContain("raw-provider-body-marker");
    } finally {
      f.close();
    }
  });

  it("awaits an admitted browser send before the store may close", async () => {
    const f = await makeFixture();
    try {
      const owned = propose(f, SESSION_A, "Drain title");
      f.store.approve(owned.id, owned.payloadHash);
      let release!: (value: { status: number; text: string }) => void;
      f.setPost(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = post(f, base(SESSION_A, owned.id, "/send"), {
        payloadHash: owned.payloadHash,
      });
      // Wait until the handler is genuinely inside the transport call.
      const started = Date.now();
      while (f.hits.length === 0) {
        if (Date.now() - started > 2_000) throw new Error("send did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      let drained = false;
      const drain = f.controls.drainAgoraSends().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The store must NOT be closable while finishSend() still owes a write.
      expect(drained).toBe(false);
      release({
        status: 201,
        text: JSON.stringify({ threadId: "thread-drained" }),
      });
      await drain;
      expect(drained).toBe(true);
      const sent = await pending;
      expect(sent.status).toBe(200);
      expect((sent.body as { outcome: string }).outcome).toBe("sent");
      expect(
        (sent.body as { proposal: { status: string } }).proposal.status,
      ).toBe("sent");
      // Already drained: a second drain is an immediate no-op.
      await f.controls.drainAgoraSends();
    } finally {
      f.close();
    }
  });

  it("keeps unknown terminal, throttles safely, and reports missing keys", async () => {
    const f = await makeFixture();
    try {
      f.setPost(async () => {
        throw new Error("socket reset");
      });
      const unknown = propose(f, SESSION_A, "Unknown title");
      f.store.approve(unknown.id, unknown.payloadHash);
      const out = await post(f, base(SESSION_A, unknown.id, "/send"), {
        payloadHash: unknown.payloadHash,
      });
      expect(out.status).toBe(200);
      expect((out.body as { outcome: string }).outcome).toBe("unknown");
      expect(f.store.show(unknown.id).status).toBe("unknown");
      const retry = await post(f, base(SESSION_A, unknown.id, "/send"), {
        payloadHash: unknown.payloadHash,
      });
      expect(retry.status).toBe(409);
      expect(f.hits).toHaveLength(1);

      const throttled = propose(f, SESSION_A, "Throttle title");
      f.store.approve(throttled.id, throttled.payloadHash);
      const wait = await post(f, base(SESSION_A, throttled.id, "/send"), {
        payloadHash: throttled.payloadHash,
      });
      expect(wait.status).toBe(429);
      expect((wait.body as { outcome: string }).outcome).toBe("throttled");
      expect(Number(wait.retryAfter)).toBeGreaterThan(0);
      expect(f.hits).toHaveLength(1);
    } finally {
      f.close();
    }

    const noKey = await makeFixture({ hostApiKey: null });
    try {
      const owned = propose(noKey, SESSION_A, "No key title");
      noKey.store.approve(owned.id, owned.payloadHash);
      const out = await post(noKey, base(SESSION_A, owned.id, "/send"), {
        payloadHash: owned.payloadHash,
      });
      expect(out.status).toBe(409);
      expect((out.body as { outcome: string }).outcome).toBe("key_missing");
      expect(noKey.hits).toHaveLength(0);
      expect(out.text).not.toContain(KEY);
    } finally {
      noKey.close();
    }
  });
});
