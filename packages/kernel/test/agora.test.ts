// AGORA participation behavior: nothing reaches transport without an exact
// human approval; approvals are one-use; writes are throttled; ambiguous
// outcomes are terminal and never resent; keys never appear in results.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AGORA_PENDING_TTL_MS, AGORA_SEND_LEASE_MS } from "../src/agora.js";
import {
  AGORA_HELLO_PATH,
  AGORA_MIN_WRITE_INTERVAL_MS,
  type AgoraTransport,
  agoraPayloadHash,
  createAgoraStore,
  RepositoryValidationError,
} from "../src/index.js";

const T0 = 1790000000000;
const KEY = "agora-secret-key-123";

interface Posted {
  path: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}

function fakeTransport(): {
  transport: AgoraTransport;
  posts: Posted[];
  gets: string[];
  setRegisterResponse: (status: number, text: string) => void;
  setPost: (
    fn: (posted: Posted) => Promise<{ status: number; text: string }>,
  ) => void;
} {
  const posts: Posted[] = [];
  const gets: string[] = [];
  let postFn: (posted: Posted) => Promise<{ status: number; text: string }> =
    async () => ({
      status: 201,
      text: "{}",
    });
  let registerResponse = {
    status: 201,
    text: JSON.stringify({ api_key: KEY }),
  };
  const transport: AgoraTransport = {
    async get(path) {
      gets.push(path);
      return {
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({ hello: "agora" }),
      };
    },
    async post(path, body, headers) {
      const posted = { path, body, headers };
      posts.push(posted);
      if (path === "/api/register") {
        return registerResponse;
      }
      return postFn(posted);
    },
  };
  return {
    transport,
    posts,
    gets,
    setRegisterResponse(status, text) {
      registerResponse = { status, text };
    },
    setPost(fn) {
      postFn = fn;
    },
  };
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agora-"));
  cleanups.push(dir);
  return join(dir, "state", "agora.sqlite");
}

interface LegacySeed {
  path: string;
  registerId: string;
  legacyId: string;
  legacyHash: string;
  token: string;
  leaseUntil: number;
}

function legacyProposalDdl(withLeaseColumns: boolean): string {
  const leaseColumns = withLeaseColumns
    ? ",\n        send_token TEXT,\n        send_lease_until INTEGER"
    : "";
  return `
    CREATE TABLE agora_proposals (
      id            TEXT PRIMARY KEY,
      operation     TEXT NOT NULL
                    CHECK (operation IN ('register','thread','reply')),
      payload_json  TEXT NOT NULL,
      payload_hash  TEXT NOT NULL,
      status        TEXT NOT NULL
                    CHECK (status IN ('pending','approved','rejected','sending','sent','unknown','failed')),
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      decided_at    INTEGER,
      consumed_at   INTEGER,
      http_status   INTEGER,
      result_code   TEXT${leaseColumns}
    ) STRICT;
    CREATE INDEX agora_proposals_status_idx
      ON agora_proposals(status, created_at);
    CREATE TABLE agora_state (
      id            TEXT PRIMARY KEY CHECK (id = 'default'),
      last_write_at INTEGER
    ) STRICT;
    CREATE TABLE agora_credentials (
      id            TEXT PRIMARY KEY CHECK (id = 'default'),
      api_key       TEXT NOT NULL,
      updated_at    INTEGER NOT NULL
    ) STRICT;
  `;
}

// Exact populated store from before session ownership: one successful
// registration (credential + sent register proposal) and one operator-approved
// thread proposal. The optional lease columns model the oldest partial store.
function seedLegacyAgoraStore(options: { leaseColumns: boolean }): LegacySeed {
  const path = tempPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const registerId = "11111111-1111-4111-8111-111111111111";
  const legacyId = "22222222-2222-4222-8222-222222222222";
  const legacyPayload = { title: "Legacy title", body: "Legacy body" };
  const legacyHash = agoraPayloadHash("thread", legacyPayload);
  const token = "legacy-send-token";
  const leaseUntil = T0 + 999_999;
  const db = new Database(path);
  try {
    db.exec(legacyProposalDdl(options.leaseColumns));
    db.prepare(
      "INSERT INTO agora_credentials (id, api_key, updated_at) VALUES ('default', ?, ?)",
    ).run(KEY, T0);
    db.prepare(
      "INSERT INTO agora_proposals (id, operation, payload_json, payload_hash, status, created_at, expires_at) VALUES (?, 'register', ?, ?, 'sent', ?, ?)",
    ).run(
      registerId,
      JSON.stringify({
        name: "Companion Harness",
        description: "Draft body",
      }),
      agoraPayloadHash("register", {
        name: "Companion Harness",
        description: "Draft body",
      }),
      T0,
      T0 + AGORA_MIN_WRITE_INTERVAL_MS,
    );
    const columns = [
      "id",
      "operation",
      "payload_json",
      "payload_hash",
      "status",
      "created_at",
      "expires_at",
    ];
    const values: Array<string | number> = [
      legacyId,
      "thread",
      JSON.stringify(legacyPayload),
      legacyHash,
      "approved",
      T0,
      T0 + AGORA_MIN_WRITE_INTERVAL_MS,
    ];
    if (options.leaseColumns) {
      columns.push("send_token", "send_lease_until");
      values.push(token, leaseUntil);
    }
    db.prepare(
      `INSERT INTO agora_proposals (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...values);
  } finally {
    db.close();
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    expect(statSync(path).mode & 0o077).toBe(0);
  }
  return { path, registerId, legacyId, legacyHash, token, leaseUntil };
}

function setup() {
  const fake = fakeTransport();
  let now = T0;
  const path = tempPath();
  const store = createAgoraStore({
    path,
    transport: fake.transport,
    clock: { now: () => now },
  });
  return {
    ...fake,
    path,
    store,
    advance(ms: number) {
      now += ms;
    },
    now() {
      return now;
    },
  };
}

describe("agora exact approval flow", () => {
  it("never sends an unapproved or hash-mutated registration", async () => {
    const f = setup();
    try {
      const payload = { name: "Companion Harness", description: "Draft body" };
      const proposal = f.store.propose({ operation: "register", payload });
      await expect(
        f.store.send(proposal.id, proposal.payloadHash),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(0);

      // A hash for different content cannot approve or send this proposal.
      const otherHash = agoraPayloadHash("register", {
        ...payload,
        description: "Changed body",
      });
      expect(() => f.store.approve(proposal.id, otherHash)).toThrow(
        RepositoryValidationError,
      );
      await expect(f.store.send(proposal.id, otherHash)).rejects.toThrow(
        RepositoryValidationError,
      );
      expect(f.posts).toHaveLength(0);
      expect(f.store.show(proposal.id).status).toBe("pending");
    } finally {
      f.store.close();
    }
  });

  it("sends the exact approved registration once and never leaks the key", async () => {
    const f = setup();
    try {
      const payload = { name: "Companion Harness", description: "Draft body" };
      const proposal = f.store.propose({ operation: "register", payload });
      f.store.approve(proposal.id, proposal.payloadHash);
      const sent = await f.store.send(proposal.id, proposal.payloadHash);
      expect(sent.kind).toBe("sent");
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]?.path).toBe("/api/register");
      expect(f.posts[0]?.body).toEqual(payload);
      expect(JSON.stringify(sent)).not.toContain(KEY);
      expect(JSON.stringify(f.store.list())).not.toContain(KEY);
      expect(JSON.stringify(f.store.show(proposal.id))).not.toContain(KEY);
      expect(f.store.getCredential()).toBe(KEY);
      if (process.platform !== "win32") {
        // The persisted key lives in a private (0600) store file.
        expect(statSync(f.path).mode & 0o077).toBe(0);
      }

      // One-use approval: a replay can never reach transport.
      await expect(
        f.store.send(proposal.id, proposal.payloadHash),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });

  it("keeps the registration credential across reopening with private DB permissions", async () => {
    const path = tempPath();
    const fake = fakeTransport();
    const first = createAgoraStore({
      path,
      transport: fake.transport,
      clock: { now: () => T0 },
    });
    const proposal = first.propose({
      operation: "register",
      payload: { name: "Companion Harness", description: "Draft body" },
    });
    try {
      first.approve(proposal.id, proposal.payloadHash);
      expect((await first.send(proposal.id, proposal.payloadHash)).kind).toBe(
        "sent",
      );
      expect(first.getCredential()).toBe(KEY);
    } finally {
      first.close();
    }

    // A fresh process/store opening the same durable DB sees the stored key
    // without any host env key and without the key appearing in results.
    const reopened = createAgoraStore({
      path,
      transport: fake.transport,
      clock: { now: () => T0 + 1 },
    });
    try {
      expect(reopened.getCredential()).toBe(KEY);
      expect(reopened.show(proposal.id).status).toBe("sent");
      expect(fake.posts).toHaveLength(1);
      expect(JSON.stringify(reopened.list())).not.toContain(KEY);
    } finally {
      reopened.close();
    }
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });

  it("rejects a registration response without a parseable key as unknown", async () => {
    const f = setup();
    try {
      f.setRegisterResponse(200, JSON.stringify({ ok: true }));
      const proposal = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(proposal.id, proposal.payloadHash);
      const out = await f.store.send(proposal.id, proposal.payloadHash);
      expect(out.kind).toBe("unknown");
      expect(f.store.show(proposal.id).status).toBe("unknown");
      expect(f.store.getCredential()).toBeNull();
      expect(f.posts).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });

  it("enforces the durable 10s write interval per key", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      await f.store.send(register.id, register.payloadHash);

      const thread = f.store.propose({
        operation: "thread",
        payload: { title: "A title", body: "A body" },
      });
      f.store.approve(thread.id, thread.payloadHash);
      const throttled = await f.store.send(thread.id, thread.payloadHash);
      expect(throttled.kind).toBe("throttled");
      expect(f.posts).toHaveLength(1);

      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const sent = await f.store.send(thread.id, thread.payloadHash);
      expect(sent.kind).toBe("sent");
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1]?.path).toBe("/api/threads");
      expect(f.posts[1]?.headers["x-agent-key"]).toBe(KEY);
      // The key is only ever inside the request header, never a result body.
      expect(JSON.stringify(sent)).not.toContain(KEY);
    } finally {
      f.store.close();
    }
  });

  it("marks transport/redirect/5xx outcomes unknown and never blind-resends", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      await f.store.send(register.id, register.payloadHash);

      f.setPost(async () => {
        throw new Error("socket reset");
      });
      const reply = f.store.propose({
        operation: "reply",
        payload: { threadId: "thread-1", body: "Reply body" },
      });
      f.store.approve(reply.id, reply.payloadHash);
      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const first = await f.store.send(reply.id, reply.payloadHash);
      expect(first.kind).toBe("unknown");
      expect(f.posts).toHaveLength(2);
      await expect(f.store.send(reply.id, reply.payloadHash)).rejects.toThrow(
        RepositoryValidationError,
      );
      expect(f.posts).toHaveLength(2);

      f.setPost(async () => ({ status: 302, text: "" }));
      const redirect = f.store.propose({
        operation: "reply",
        payload: { threadId: "thread-2", body: "Other reply" },
      });
      f.store.approve(redirect.id, redirect.payloadHash);
      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const redirected = await f.store.send(redirect.id, redirect.payloadHash);
      expect(redirected.kind).toBe("unknown");
    } finally {
      f.store.close();
    }
  });

  it("marks a clear 4xx as failed and requires a new proposal to retry", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      await f.store.send(register.id, register.payloadHash);

      f.setPost(async () => ({ status: 403, text: "denied" }));
      const thread = f.store.propose({
        operation: "thread",
        payload: { title: "A title", body: "A body" },
      });
      f.store.approve(thread.id, thread.payloadHash);
      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const out = await f.store.send(thread.id, thread.payloadHash);
      expect(out.kind).toBe("failed");
      expect(f.store.show(thread.id).status).toBe("failed");
      await expect(f.store.send(thread.id, thread.payloadHash)).rejects.toThrow(
        RepositoryValidationError,
      );
    } finally {
      f.store.close();
    }
  });

  it("rejects approval states across restart and exposes only fixed read paths", async () => {
    const path = tempPath();
    const fake = fakeTransport();
    const first = createAgoraStore({
      path,
      transport: fake.transport,
      clock: { now: () => T0 },
    });
    const proposal = first.propose({
      operation: "register",
      payload: { name: "Companion Harness", description: "Draft body" },
    });
    first.approve(proposal.id, proposal.payloadHash);
    first.close();

    const second = createAgoraStore({
      path,
      transport: fake.transport,
      clock: { now: () => T0 + 1 },
    });
    try {
      expect(second.show(proposal.id).status).toBe("approved");
      const hello = await second.readHello();
      expect(hello.untrusted).toBe(true);
      expect(fake.gets).toEqual([AGORA_HELLO_PATH]);
      await expect(second.readThread("../etc/passwd")).rejects.toThrow(
        RepositoryValidationError,
      );
    } finally {
      second.close();
    }
  });

  it("recomputes the hash from stored content and refuses a mutated approval", async () => {
    const f = setup();
    const proposal = f.store.propose({
      operation: "register",
      payload: { name: "Companion Harness", description: "Draft body" },
    });
    f.store.approve(proposal.id, proposal.payloadHash);
    f.store.close();

    // Simulate tampering that preserves the approved hash column.
    const raw = new Database(f.path);
    try {
      raw
        .prepare("UPDATE agora_proposals SET payload_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            name: "Companion Harness",
            description: "Mutated body",
          }),
          proposal.id,
        );
    } finally {
      raw.close();
    }

    const reopened = createAgoraStore({
      path: f.path,
      transport: f.transport,
      clock: { now: () => T0 },
    });
    try {
      expect(reopened.show(proposal.id).payloadHash).not.toBe(
        proposal.payloadHash,
      );
      await expect(
        reopened.send(proposal.id, proposal.payloadHash),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(0);
      expect(reopened.show(proposal.id).status).toBe("approved");
    } finally {
      reopened.close();
    }
  });

  it("does not clobber another live CLI's in-flight send", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      expect((await f.store.send(register.id, register.payloadHash)).kind).toBe(
        "sent",
      );

      let markStarted!: () => void;
      let release!: (value: { status: number; text: string }) => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      f.setPost(
        () =>
          new Promise<{ status: number; text: string }>((resolve) => {
            markStarted();
            release = resolve;
          }),
      );

      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const thread = f.store.propose({
        operation: "thread",
        payload: { title: "A title", body: "A body" },
      });
      f.store.approve(thread.id, thread.payloadHash);
      const pending = f.store.send(thread.id, thread.payloadHash);
      await started;

      const other = createAgoraStore({
        path: f.path,
        transport: f.transport,
        clock: { now: () => f.now() + 1 },
      });
      try {
        expect(other.show(thread.id).status).toBe("sending");
        expect(other.list("sending").some((row) => row.id === thread.id)).toBe(
          true,
        );
      } finally {
        other.close();
      }

      release({ status: 201, text: "{}" });
      expect((await pending).kind).toBe("sent");
      expect(f.store.show(thread.id).status).toBe("sent");
    } finally {
      f.store.close();
    }
  });

  it("recovers a crashed send as unknown only after its lease expires", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      await f.store.send(register.id, register.payloadHash);

      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const thread = f.store.propose({
        operation: "thread",
        payload: { title: "A title", body: "A body" },
      });
      f.store.approve(thread.id, thread.payloadHash);
      const began = f.store.beginSend({
        id: thread.id,
        expectedHash: thread.payloadHash,
        now: f.now(),
      });
      expect(began.kind).toBe("sending");
      const reservedAt = f.now();
      f.store.close();

      const live = createAgoraStore({
        path: f.path,
        transport: f.transport,
        clock: { now: () => reservedAt + AGORA_SEND_LEASE_MS - 1 },
      });
      try {
        expect(live.show(thread.id).status).toBe("sending");
      } finally {
        live.close();
      }

      const expired = createAgoraStore({
        path: f.path,
        transport: f.transport,
        clock: { now: () => reservedAt + AGORA_SEND_LEASE_MS },
      });
      try {
        expect(expired.show(thread.id).status).toBe("unknown");
        await expect(
          expired.send(thread.id, thread.payloadHash),
        ).rejects.toThrow(RepositoryValidationError);
        expect(f.posts).toHaveLength(1);
      } finally {
        expired.close();
      }
    } finally {
      try {
        f.store.close();
      } catch {
        // Already closed after simulating the crash.
      }
    }
  });

  it("reserves one-use sends and throttle atomically across store instances", () => {
    const f = setup();
    const first = f.store.propose({
      operation: "register",
      payload: { name: "Companion Harness", description: "First body" },
    });
    const second = f.store.propose({
      operation: "register",
      payload: { name: "Companion Harness", description: "Second body" },
    });
    f.store.approve(first.id, first.payloadHash);
    f.store.approve(second.id, second.payloadHash);
    const other = createAgoraStore({
      path: f.path,
      transport: f.transport,
      clock: { now: () => f.now() },
    });
    try {
      expect(
        f.store.beginSend({
          id: first.id,
          expectedHash: first.payloadHash,
          now: f.now(),
        }).kind,
      ).toBe("sending");
      expect(() =>
        other.beginSend({
          id: first.id,
          expectedHash: first.payloadHash,
          now: f.now(),
        }),
      ).toThrow(RepositoryValidationError);

      const throttled = other.beginSend({
        id: second.id,
        expectedHash: second.payloadHash,
        now: f.now(),
      });
      expect(throttled.kind).toBe("throttled");
      if (throttled.kind === "throttled") {
        expect(throttled.retryAfterMs).toBe(AGORA_MIN_WRITE_INTERVAL_MS);
      }

      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      expect(
        other.beginSend({
          id: second.id,
          expectedHash: second.payloadHash,
          now: f.now(),
        }).kind,
      ).toBe("sending");
    } finally {
      other.close();
      f.store.close();
    }
  });

  it("binds model-created proposals to one session across restarts and ignores operator drafts", async () => {
    const f = setup();
    const sessionA = "11111111-1111-4111-8111-111111111111";
    const sessionB = "22222222-2222-4222-8222-222222222222";
    let ownedId = "";
    let ownedHash = "";
    try {
      f.store.setCredential(KEY);
      const operatorDraft = f.store.propose({
        operation: "thread",
        payload: { title: "Operator title", body: "Operator body" },
      });
      const owned = f.store.propose({
        operation: "thread",
        payload: { title: "Session A title", body: "Session A body" },
        sessionId: sessionA,
      });
      ownedId = owned.id;
      ownedHash = owned.payloadHash;
      expect(owned.sessionId).toBe(sessionA);
      expect(f.store.listForSession(sessionA)).toHaveLength(1);
      expect(f.store.listForSession(sessionB)).toHaveLength(0);
      expect(() => f.store.showForSession(owned.id, sessionB)).toThrow(
        RepositoryValidationError,
      );
      expect(() => f.store.showForSession(operatorDraft.id, sessionA)).toThrow(
        RepositoryValidationError,
      );
      // The model-side send path cannot consume another session's or an
      // operator-created draft, even after the operator approves it.
      f.store.approve(operatorDraft.id, operatorDraft.payloadHash);
      await expect(
        f.store.send(operatorDraft.id, operatorDraft.payloadHash, {
          sessionId: sessionA,
          now: f.now(),
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(0);

      // Approval happens in the operator CLI (same store); the model-side
      // send must still match the exact hash and its own session.
      f.store.approve(owned.id, owned.payloadHash);
      await expect(
        f.store.send(owned.id, owned.payloadHash, {
          sessionId: sessionB,
          now: f.now(),
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(0);

      const result = await f.store.send(owned.id, owned.payloadHash, {
        sessionId: sessionA,
        now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS,
      });
      expect(result.kind).toBe("sent");
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]?.path).toBe("/api/threads");
      expect(f.posts[0]?.body).toEqual({
        title: "Session A title",
        body: "Session A body",
      });
      expect(JSON.stringify(result)).not.toContain(KEY);
    } finally {
      f.store.close();
    }

    const restarted = createAgoraStore({
      path: f.path,
      transport: f.transport,
      clock: { now: () => f.now() + AGORA_MIN_WRITE_INTERVAL_MS },
    });
    try {
      const rows = restarted.listForSession(sessionA);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
      expect(restarted.listForSession(sessionB)).toHaveLength(0);
      await expect(
        restarted.send(ownedId, ownedHash, {
          sessionId: sessionA,
          now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("creates a fresh actionable draft instead of deduplicating expired content", () => {
    const f = setup();
    try {
      const session = "55555555-5555-4555-8555-555555555555";
      const payload = { title: "Expiring title", body: "Expiring body" };
      const first = f.store.propose({
        operation: "thread",
        payload,
        sessionId: session,
      });
      expect(first.status).toBe("pending");
      // Advance past the pending TTL WITHOUT any list/show refresh (which is
      // what would otherwise flip the stale row to failed).
      f.advance(AGORA_PENDING_TTL_MS + 1);
      const second = f.store.propose({
        operation: "thread",
        payload,
        sessionId: session,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
      // The fresh draft is actionable at the current instant.
      expect(() =>
        f.store.approve(second.id, second.payloadHash),
      ).not.toThrow();
    } finally {
      f.store.close();
    }
  });

  it("keeps browser approval human-send-only and durably distinct from operator approval", async () => {
    const f = setup();
    const session = "44444444-4444-4444-8444-444444444444";
    let store = f.store;
    try {
      store.setCredential(KEY);

      // An operator approval allows the model-requested path later.
      const operator = store.propose({
        operation: "thread",
        payload: { title: "Operator send", body: "Operator body" },
        sessionId: session,
      });
      expect(
        store.approve(operator.id, operator.payloadHash).approvalSource,
      ).toBe("operator");
      expect(
        (
          await store.send(operator.id, operator.payloadHash, {
            sessionId: session,
            actor: "model",
            now: f.now(),
          })
        ).kind,
      ).toBe("sent");
      expect(f.posts).toHaveLength(1);

      // A browser approval is a different authority: it needs the separate
      // human Send click and must not be consumed by the model path.
      const browser = store.propose({
        operation: "thread",
        payload: { title: "Browser send", body: "Browser body" },
        sessionId: session,
      });
      const approved = store.approveForSession(
        browser.id,
        browser.payloadHash,
        session,
        f.now() + 1,
      );
      expect(approved.status).toBe("approved");
      expect(approved.approvalSource).toBe("browser");

      // Authority is checked before throttle/lease/transport: the last write
      // was just now, yet this is a state conflict, not a throttle.
      await expect(
        store.send(browser.id, browser.payloadHash, {
          sessionId: session,
          actor: "model",
          now: f.now() + 2,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      // A session-bound send defaults to the model actor.
      await expect(
        store.send(browser.id, browser.payloadHash, {
          sessionId: session,
          now: f.now() + 2,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(1);
      expect(store.show(browser.id).status).toBe("approved");

      // Reopen: browser authority is persisted, never an in-memory lock.
      store.close();
      store = createAgoraStore({
        path: f.path,
        transport: f.transport,
        clock: { now: () => f.now() },
      });
      expect(store.show(browser.id).approvalSource).toBe("browser");
      await expect(
        store.send(browser.id, browser.payloadHash, {
          sessionId: session,
          actor: "model",
          now: f.now() + 3,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(1);

      // The explicit human send consumes the same one-use approval exactly
      // once; a replay is refused.
      const human = await store.send(browser.id, browser.payloadHash, {
        sessionId: session,
        actor: "human",
        now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS,
      });
      expect(human.kind).toBe("sent");
      expect(f.posts).toHaveLength(2);
      await expect(
        store.send(browser.id, browser.payloadHash, {
          sessionId: session,
          actor: "human",
          now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS + 1,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(2);

      // Stale/tampered hashes still refuse before transport.
      const stale = store.propose({
        operation: "thread",
        payload: { title: "Stale send", body: "Stale body" },
        sessionId: session,
        now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS + 1,
      });
      store.approveForSession(
        stale.id,
        stale.payloadHash,
        session,
        f.now() + AGORA_MIN_WRITE_INTERVAL_MS + 2,
      );
      await expect(
        store.send(stale.id, "0".repeat(64), {
          sessionId: session,
          actor: "human",
          now: f.now() + AGORA_MIN_WRITE_INTERVAL_MS + 3,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(f.posts).toHaveLength(2);
      expect(store.show(stale.id).status).toBe("approved");
    } finally {
      store.close();
    }
  });

  it("upgrades a populated pre-session store and keeps legacy rows operator-only", async () => {
    const seed = seedLegacyAgoraStore({ leaseColumns: true });
    const fake = fakeTransport();
    const session = "33333333-3333-4333-8333-333333333333";
    const now = T0 + 10;
    const store = createAgoraStore({
      path: seed.path,
      transport: fake.transport,
      clock: { now: () => now },
    });
    try {
      expect(store.getCredential()).toBe(KEY);
      expect(JSON.stringify(store.list())).not.toContain(KEY);

      // Existing registration and its sent proposal survive the upgrade.
      const registration = store.show(seed.registerId);
      expect(registration.operation).toBe("register");
      expect(registration.status).toBe("sent");
      expect(registration.sessionId).toBeNull();

      // A legacy proposal has no owner and is therefore invisible to model
      // tools bound to any conversation session.
      const legacy = store.show(seed.legacyId);
      expect(legacy.sessionId).toBeNull();
      expect(legacy.status).toBe("approved");
      // Pre-provenance approvals preserve operator semantics.
      expect(legacy.approvalSource).toBe("operator");
      expect(store.listForSession(session)).toEqual([]);
      expect(() => store.showForSession(seed.legacyId, session)).toThrow(
        RepositoryValidationError,
      );
      await expect(
        store.send(seed.legacyId, seed.legacyHash, {
          sessionId: session,
          now,
        }),
      ).rejects.toThrow(RepositoryValidationError);
      expect(fake.posts).toHaveLength(0);

      // New proposals get a durable session owner and work normally.
      const fresh = store.propose({
        operation: "thread",
        payload: { title: "New title", body: "New body" },
        sessionId: session,
        now,
      });
      expect(fresh.sessionId).toBe(session);
      expect(store.listForSession(session)).toHaveLength(1);
      store.approve(fresh.id, fresh.payloadHash, now + 1);
      const sent = await store.send(fresh.id, fresh.payloadHash, {
        sessionId: session,
        now: now + 2,
      });
      expect(sent.kind).toBe("sent");
      expect(fake.posts).toHaveLength(1);
      expect(JSON.stringify(store.listForSession(session))).not.toContain(KEY);
    } finally {
      store.close();
    }

    const raw = new Database(seed.path, { readonly: true });
    try {
      const row = raw
        .prepare(
          "SELECT session_id, approval_source, send_token, send_lease_until FROM agora_proposals WHERE id = ?",
        )
        .get(seed.legacyId) as {
        session_id: string | null;
        approval_source: string | null;
        send_token: string | null;
        send_lease_until: number | null;
      };
      expect(row).toEqual({
        session_id: null,
        approval_source: "operator",
        send_token: seed.token,
        send_lease_until: seed.leaseUntil,
      });
      const columns = (
        raw.prepare("PRAGMA table_info(agora_proposals)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(columns).toContain("session_id");
      expect(columns).toContain("approval_source");
      expect(columns).toContain("result_thread_id");
      expect(columns).toContain("result_url");
      const indexes = (
        raw.prepare("PRAGMA index_list(agora_proposals)").all() as Array<{
          name: string;
        }>
      ).map((index) => index.name);
      expect(indexes).toContain("agora_proposals_session_idx");
    } finally {
      raw.close();
    }

    const reopened = createAgoraStore({
      path: seed.path,
      transport: fake.transport,
      clock: { now: () => now + 100 },
    });
    try {
      expect(reopened.getCredential()).toBe(KEY);
      const rows = reopened.listForSession(session);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
      expect(reopened.show(seed.registerId).status).toBe("sent");
      expect(reopened.show(seed.legacyId).sessionId).toBeNull();
      expect(() => reopened.showForSession(seed.legacyId, session)).toThrow(
        RepositoryValidationError,
      );
    } finally {
      reopened.close();
    }
    if (process.platform !== "win32") {
      expect(statSync(seed.path).mode & 0o077).toBe(0);
    }
  });

  it("persists only a verified result target and never the raw provider body", async () => {
    const f = setup();
    try {
      const register = f.store.propose({
        operation: "register",
        payload: { name: "Companion Harness", description: "Draft body" },
      });
      f.store.approve(register.id, register.payloadHash);
      await f.store.send(register.id, register.payloadHash);

      f.setPost(async () => ({
        status: 201,
        text: JSON.stringify({
          id: "thread-abc_1",
          secret: "provider-raw-body-marker",
        }),
      }));
      const thread = f.store.propose({
        operation: "thread",
        payload: { title: "A title", body: "A body" },
      });
      f.store.approve(thread.id, thread.payloadHash);
      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      const sent = await f.store.send(thread.id, thread.payloadHash);
      expect(sent.kind).toBe("sent");
      expect(f.store.show(thread.id).resultThreadId).toBe("thread-abc_1");
      expect(f.store.show(thread.id).resultUrl).toBe(
        "https://agora.grimoire-fio.workers.dev/t/thread-abc_1",
      );
      expect(JSON.stringify(f.store.show(thread.id))).not.toContain(
        "provider-raw-body-marker",
      );

      // Unsafe/foreign URL is never persisted or synthesized.
      f.setPost(async () => ({
        status: 201,
        text: JSON.stringify({ url: "http://evil.example/t/thread-x" }),
      }));
      const unsafe = f.store.propose({
        operation: "thread",
        payload: { title: "Unsafe", body: "Unsafe body" },
      });
      f.store.approve(unsafe.id, unsafe.payloadHash);
      f.advance(AGORA_MIN_WRITE_INTERVAL_MS);
      await f.store.send(unsafe.id, unsafe.payloadHash);
      expect(f.store.show(unsafe.id).resultUrl).toBeNull();
      expect(f.store.show(unsafe.id).resultThreadId).toBeNull();
    } finally {
      f.store.close();
    }

    const reopened = createAgoraStore({
      path: f.path,
      transport: f.transport,
      clock: { now: () => f.now() + AGORA_MIN_WRITE_INTERVAL_MS },
    });
    try {
      const rows = reopened.list().filter((row) => row.status === "sent");
      expect(rows.some((row) => row.resultUrl !== null)).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("adds all pre-lease columns in one reopenable upgrade", () => {
    const seed = seedLegacyAgoraStore({ leaseColumns: false });
    const fake = fakeTransport();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = createAgoraStore({
        path: seed.path,
        transport: fake.transport,
        clock: { now: () => T0 + 10 },
      });
      try {
        expect(store.getCredential()).toBe(KEY);
        expect(store.show(seed.registerId).status).toBe("sent");
        expect(store.show(seed.legacyId).sessionId).toBeNull();
        expect(store.show(seed.legacyId).status).toBe("approved");
      } finally {
        store.close();
      }
    }

    const raw = new Database(seed.path, { readonly: true });
    try {
      const columns = (
        raw.prepare("PRAGMA table_info(agora_proposals)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "session_id",
          "send_token",
          "send_lease_until",
        ]),
      );
    } finally {
      raw.close();
    }
  });
});
