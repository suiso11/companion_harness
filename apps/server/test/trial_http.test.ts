// Trial proposal/approval HTTP behavioral test (real Hono app + real DB).
//
// Exercises the ACTUAL trial routes end to end (no listener): disabled
// config answers a fixed trials_disabled without touching the DB,
// stage -> approve happy path with the frozen config profile, body
// profile/alias overrides rejected, foreign-session 404s, idempotent
// replay on same key/body with 409 on drift, and GETs that never
// expire/mutate. Plus config parsing and the pure trial card model.

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
import { loadServerConfig, ServerConfigError } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import { trialProposalModel, trialStatusText } from "../src/ui/reducer.js";

const FP = "b".repeat(64);
const REV = "a".repeat(40);

function trialConfigJson(): string {
  return JSON.stringify({
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    configFingerprint: FP,
    sourceRevision: REV,
    currentModel: "test-model",
    disclosedWholeRepoRead: true,
    timeoutMs: 60000,
    maxOutputBytes: 1000000,
    workspaceAlias: "ws",
    runner: {
      nodeRealpath: "/usr/bin/node",
      bridgeScriptPath: "/opt/bridge.mjs",
      bridgeConfigTemplatePath: "/opt/bridge.template.json",
      systemctlRealpath: "/usr/bin/systemctl",
      xdgRuntimeDir: "/run/user/1000",
      relay: {
        maxRequestBytes: 1048576,
        maxModelCalls: 8,
        maxOutputTokens: 256,
        maxResponseBytes: 1048576,
        perCallTimeoutMs: 5000,
        maxConcurrent: 1,
      },
      observe: {
        activeTimeoutMs: 5000,
        goneTimeoutMs: 5000,
        pollIntervalMs: 50,
      },
      pollMs: 500,
    },
  });
}

function trialModelJson(): string {
  return JSON.stringify({
    adapter: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "test-model",
  });
}

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  db: {
    raw: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } };
  };
  close: () => void;
}

async function makeApp(withTrial: boolean): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const env: NodeJS.ProcessEnv = {
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-trial-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  };
  if (withTrial) {
    env.COMPANION_AUTONOMY_JSON = trialConfigJson();
    env.COMPANION_MODEL_JSON = trialModelJson();
  }
  const config = loadServerConfig(env);
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return {
    ...created,
    repo,
    db: handle as unknown as Fixture["db"],
    close: () => closeKernelDatabase(handle),
  };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", host: "127.0.0.1", ...extra };
}

async function post(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "POST",
    headers: headers(key === undefined ? {} : { "idempotency-key": key }),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

function trialProposalCount(fixture: Fixture): number {
  const row = fixture.db.raw
    .prepare("SELECT COUNT(*) AS n FROM trial_proposals")
    .get() as { n: number };
  return row.n;
}

/** Fixture authority: explicit user goal + kind=task child, control resumed. */
function stageAuthority(
  repo: KernelRepository,
  sessionId: string,
  scope: string,
): { taskId: string } {
  const now = Date.now();
  const goal = repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "ship it",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now },
  );
  const task = repo.createAutonomyTask(
    sessionId,
    {
      scope,
      title: "do work",
      kind: "task",
      speaker: "user",
      parentPurposeId: goal.body.id,
    },
    { key: randomUUID(), now: now + 1 },
  );
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: now + 2 },
  );
  return { taskId: task.body.id };
}

function stageBody(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    objective: "implement the thing",
    acceptance: ["it works"],
    literalPatchPaths: ["src/a.ts"],
    operation: "implement",
    readOnlyMode: false,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    possibleExternalDataConsent: true,
    objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
    requiredChecks: ["lint"],
    ...extra,
  };
}

describe("trial HTTP disabled surface", () => {
  it("answers trials_disabled without touching the DB", async () => {
    const fixture = await makeApp(false);
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/trials`;

      const staged = await post(
        app,
        base,
        stageBody(randomUUID()),
        randomUUID(),
      );
      expect(staged.status).toBe(409);
      expect(
        (staged.body as { error: { code: string; message: string } }).error
          .code,
      ).toBe("trials_disabled");

      const approved = await post(
        app,
        `${base}/${randomUUID()}/approve`,
        {},
        randomUUID(),
      );
      expect(approved.status).toBe(409);
      expect((approved.body as { error: { code: string } }).error.code).toBe(
        "trials_disabled",
      );

      const listed = await get(app, base);
      expect(listed.status).toBe(404);
      expect((listed.body as { error: { code: string } }).error.code).toBe(
        "trials_disabled",
      );

      const single = await get(app, `${base}/${randomUUID()}`);
      expect(single.status).toBe(404);
      expect((single.body as { error: { code: string } }).error.code).toBe(
        "trials_disabled",
      );

      const grant = await get(
        app,
        `/api/sessions/${sessionId}/trial-grants/${randomUUID()}`,
      );
      expect(grant.status).toBe(404);
      expect((grant.body as { error: { code: string } }).error.code).toBe(
        "trials_disabled",
      );

      const expired = await post(app, `${base}/${randomUUID()}/expire`, {});
      expect(expired.status).toBe(409);
      expect((expired.body as { error: { code: string } }).error.code).toBe(
        "trials_disabled",
      );

      // No trial row was persisted by any disabled attempt.
      expect(trialProposalCount(fixture)).toBe(0);
    } finally {
      fixture.close();
    }
  });
});

describe("trial HTTP proposal lifecycle", () => {
  it("stages then approves with the frozen config profile", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b1");
      const base = `/api/sessions/${sessionId}/trials`;

      const staged = await post(app, base, stageBody(taskId), randomUUID());
      expect(staged.status).toBe(201);
      const proposal = staged.body as Record<string, unknown>;
      expect(proposal.status).toBe("staged");
      expect(proposal.objective).toBe("implement the thing");
      expect(proposal.acceptance).toEqual(["it works"]);
      expect(proposal.literalPatchPaths).toEqual(["src/a.ts"]);
      expect(proposal.operation).toBe("implement");
      expect(proposal.readOnlyMode).toBe(false);
      expect(proposal.timeoutMs).toBe(5000);
      expect(proposal.maxOutputBytes).toBe(10000);
      expect(proposal.requiredChecks).toEqual(["lint"]);
      expect(proposal.workspaceAlias).toBe("ws");
      expect(proposal.profile).toEqual({
        configFingerprint: FP,
        sourceRevision: REV,
      });
      const proposalId = proposal.id as string;

      const listed = await get(app, base);
      expect(listed.status).toBe(200);
      expect(((listed.body as { items: unknown[] }).items ?? []).length).toBe(
        1,
      );

      const single = await get(app, `${base}/${proposalId}`);
      expect(single.status).toBe(200);
      expect((single.body as { id: string }).id).toBe(proposalId);
      expect((single.body as { workspaceAlias: unknown }).workspaceAlias).toBe(
        "ws",
      );
      expect((single.body as { profile: unknown }).profile).toEqual({
        configFingerprint: FP,
        sourceRevision: REV,
      });

      const approved = await post(
        app,
        `${base}/${proposalId}/approve`,
        {},
        randomUUID(),
      );
      expect(approved.status).toBe(201);
      const executionId = (approved.body as { executionId: string })
        .executionId;
      expect(typeof executionId).toBe("string");

      const listedAfter = await get(app, base);
      expect(listedAfter.status).toBe(200);
      expect(
        (
          (listedAfter.body as { items: { id: string; status: string }[] })
            .items[0] as { id: string; status: string }
        ).status,
      ).toBe("granted");

      const grant = await get(
        app,
        `/api/sessions/${sessionId}/trial-grants/${executionId}`,
      );
      expect(grant.status).toBe(200);
      const grantBody = grant.body as {
        grant: { executionId: string; proposalId: string };
        proposal: { id: string };
        request: unknown;
      };
      expect(grantBody.grant.executionId).toBe(executionId);
      expect(grantBody.grant.proposalId).toBe(proposalId);
      expect(grantBody.proposal.id).toBe(proposalId);
      expect(grantBody.request).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("reads a proposal beyond the default list window by id", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b1x");
      const base = `/api/sessions/${sessionId}/trials`;
      const frozenProfile = {
        available: true,
        enabled: true,
        mandatoryChecks: ["lint"],
        configFingerprint: FP,
        sourceRevision: REV,
        currentModel: "test-model",
        disclosedWholeRepoRead: true,
        timeoutMs: 60000,
        maxOutputBytes: 1000000,
      };
      const t0 = Date.now();
      const first = repo.stageTrial(sessionId, stageBody(taskId), {
        key: randomUUID(),
        now: t0,
        profile: frozenProfile,
        workspaceAlias: "ws",
      });
      const firstId = first.body.id;
      for (let i = 0; i < 54; i++) {
        repo.stageTrial(sessionId, stageBody(taskId), {
          key: randomUUID(),
          now: t0 + 1 + i,
          profile: frozenProfile,
          workspaceAlias: "ws",
        });
      }
      const listed = await get(app, base);
      expect(listed.status).toBe(200);
      expect(((listed.body as { items: unknown[] }).items ?? []).length).toBe(
        50,
      );
      // The oldest proposal falls outside the default page but the detail
      // route reads by id directly (no list-limit 404).
      const single = await get(app, `${base}/${firstId}`);
      expect(single.status).toBe(200);
      expect((single.body as { id: string }).id).toBe(firstId);
    } finally {
      fixture.close();
    }
  });

  it("rejects profile/alias overrides in the body", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b2");
      const base = `/api/sessions/${sessionId}/trials`;

      const aliasStage = await post(
        app,
        base,
        stageBody(taskId, { workspaceAlias: "evil" }),
        randomUUID(),
      );
      expect(aliasStage.status).toBe(400);

      const profileStage = await post(
        app,
        base,
        stageBody(taskId, {
          profile: {
            available: true,
            enabled: true,
            mandatoryChecks: [],
            configFingerprint: FP,
            sourceRevision: REV,
            currentModel: "x",
            disclosedWholeRepoRead: true,
            timeoutMs: 1000,
            maxOutputBytes: 1024,
          },
        }),
        randomUUID(),
      );
      expect(profileStage.status).toBe(400);

      const staged = await post(app, base, stageBody(taskId), randomUUID());
      expect(staged.status).toBe(201);
      const proposalId = (staged.body as { id: string }).id;

      const aliasApprove = await post(
        app,
        `${base}/${proposalId}/approve`,
        { workspaceAlias: "evil" },
        randomUUID(),
      );
      expect(aliasApprove.status).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("answers 404 for foreign sessions", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b3");
      const ghost = randomUUID();

      const staged = await post(
        app,
        `/api/sessions/${ghost}/trials`,
        stageBody(taskId),
        randomUUID(),
      );
      expect(staged.status).toBe(404);

      const listed = await get(app, `/api/sessions/${ghost}/trials`);
      expect(listed.status).toBe(404);

      const approved = await post(
        app,
        `/api/sessions/${ghost}/trials/${randomUUID()}/approve`,
        {},
        randomUUID(),
      );
      expect(approved.status).toBe(404);
    } finally {
      fixture.close();
    }
  });

  it("replays the same key/body and conflicts on drift", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b4");
      const base = `/api/sessions/${sessionId}/trials`;

      const key = randomUUID();
      const frozenBody = stageBody(taskId);
      const first = await post(app, base, frozenBody, key);
      expect(first.status).toBe(201);
      const replay = await post(app, base, frozenBody, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);

      const drift = await post(
        app,
        base,
        stageBody(taskId, { objective: "something else entirely" }),
        key,
      );
      expect(drift.status).toBe(409);
      expect((drift.body as { error: { code: string } }).error.code).toBe(
        "idempotency_key_reused",
      );

      const proposalId = (first.body as { id: string }).id;
      const approveKey = randomUUID();
      const approved = await post(
        app,
        `${base}/${proposalId}/approve`,
        {},
        approveKey,
      );
      expect(approved.status).toBe(201);
      const approveReplay = await post(
        app,
        `${base}/${proposalId}/approve`,
        {},
        approveKey,
      );
      expect(approveReplay.status).toBe(201);
      expect(approveReplay.body).toEqual(approved.body);
    } finally {
      fixture.close();
    }
  });

  it("reads never expire or mutate, and explicit expire cancels", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b5");
      const base = `/api/sessions/${sessionId}/trials`;

      const staged = await post(app, base, stageBody(taskId), randomUUID());
      expect(staged.status).toBe(201);
      const proposalId = (staged.body as { id: string }).id;

      // Pure reads leave the staged proposal untouched.
      const first = await get(app, base);
      const second = await get(app, base);
      expect(first.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(
        (second.body as { items: { status: string }[] }).items[0]?.status,
      ).toBe("staged");

      const expired = await post(app, `${base}/${proposalId}/expire`, {});
      expect(expired.status).toBe(200);
      expect((expired.body as { status: string }).status).toBe("expired");

      // Reads of the expired proposal never mutate it further.
      const afterFirst = await get(app, `${base}/${proposalId}`);
      const afterSecond = await get(app, `${base}/${proposalId}`);
      expect(afterFirst.status).toBe(200);
      expect(afterSecond.body).toEqual(afterFirst.body);
      expect((afterSecond.body as { status: string }).status).toBe("expired");

      // Expire is state-idempotent: a second expire keeps the status.
      const expiredAgain = await post(app, `${base}/${proposalId}/expire`, {});
      expect(expiredAgain.status).toBe(200);
      expect((expiredAgain.body as { status: string }).status).toBe("expired");
    } finally {
      fixture.close();
    }
  });

  it("rejects an idempotency key on the keyless expire route", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b6");
      const base = `/api/sessions/${sessionId}/trials`;

      const staged = await post(app, base, stageBody(taskId), randomUUID());
      const proposalId = (staged.body as { id: string }).id;
      const keyed = await post(
        app,
        `${base}/${proposalId}/expire`,
        {},
        randomUUID(),
      );
      expect(keyed.status).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("expires a proposal that falls outside the default list window", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "b7");
      const base = `/api/sessions/${sessionId}/trials`;

      let firstId = "";
      for (let i = 0; i < 55; i++) {
        const staged = await post(app, base, stageBody(taskId), randomUUID());
        expect(staged.status).toBe(201);
        if (i === 0) firstId = (staged.body as { id: string }).id;
      }
      // The oldest proposal is outside the default list limit of 50, but an
      // explicit expire by id must still succeed (not 404).
      const expired = await post(app, `${base}/${firstId}/expire`, {});
      expect(expired.status).toBe(200);
      expect((expired.body as { status: string }).status).toBe("expired");
      const reread = await get(app, `${base}/${firstId}`);
      expect(reread.status).toBe(200);
      expect((reread.body as { status: string }).status).toBe("expired");
    } finally {
      fixture.close();
    }
  });
});

describe("trial config parsing", () => {
  function baseEnv(dbPath: string): NodeJS.ProcessEnv {
    return {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "info",
    };
  }

  function tempDbPath(): string {
    return join(
      mkdtempSync(join(tmpdir(), "companion-trial-cfg-")),
      "db.sqlite",
    );
  }

  it("is disabled by default and frozen when set", () => {
    expect(loadServerConfig(baseEnv(tempDbPath())).trial).toBeNull();
    const config = loadServerConfig({
      ...baseEnv(tempDbPath()),
      COMPANION_AUTONOMY_JSON: trialConfigJson(),
      COMPANION_MODEL_JSON: trialModelJson(),
    });
    expect(config.trial?.workspaceAlias).toBe("ws");
    expect(config.trial?.mandatoryChecks).toEqual(["lint"]);
    expect(Object.isFrozen(config.trial)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects unknown keys, missing fields, and bad values without defaults", () => {
    const full = JSON.parse(trialConfigJson()) as Record<string, unknown>;
    const badAlias = { ...full, workspaceAlias: "Bad Alias!" };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(badAlias),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    const unknownKey = { ...full, profile: {} };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(unknownKey),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    // No defaults for caps/checks: a missing field fails closed.
    const { timeoutMs: _drop, ...noCaps } = full;
    void _drop;
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(noCaps),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    const { mandatoryChecks: _checks, ...noChecks } = full;
    void _checks;
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(noChecks),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: "{not json",
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
  });

  it("requires the runner block with absolute paths, relay caps, timeouts, pollMs", () => {
    const full = JSON.parse(trialConfigJson()) as Record<string, unknown>;
    const { runner: _runner, ...noRunner } = full;
    void _runner;
    // Missing runner fails closed.
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(noRunner),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow("trial config runner is required");
    // Relative path fails closed without echoing the value.
    const badPath = {
      ...full,
      runner: {
        ...(full.runner as Record<string, unknown>),
        nodeRealpath: "relative/node",
      },
    };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(badPath),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    // Missing relay cap fails closed (no defaults).
    const badRelay = {
      ...full,
      runner: {
        ...(full.runner as Record<string, unknown>),
        relay: { maxRequestBytes: 1024 },
      },
    };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(badRelay),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
    // Missing model config fails closed when trials are enabled.
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: trialConfigJson(),
      }),
    ).toThrow("trial config requires model config");
    // Unknown runner key fails closed.
    const unknownRunnerKey = {
      ...full,
      runner: { ...(full.runner as Record<string, unknown>), extra: 1 },
    };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(unknownRunnerKey),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow(ServerConfigError);
  });

  it("relay maxResponseBytes boundary: ceiling accepted, ceiling+1 rejected", () => {
    const full = JSON.parse(trialConfigJson()) as Record<string, unknown>;
    const runner = full.runner as Record<string, unknown>;
    const relay = runner.relay as Record<string, unknown>;
    // Ceiling (1048576) accepted.
    const atCeiling = {
      ...full,
      runner: { ...runner, relay: { ...relay, maxResponseBytes: 1048576 } },
    };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(atCeiling),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).not.toThrow();
    // Ceiling + 1 rejected with the existing fixed error.
    const overCeiling = {
      ...full,
      runner: { ...runner, relay: { ...relay, maxResponseBytes: 1048577 } },
    };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(overCeiling),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow("trial runner relay caps are invalid");
  });
});

describe("trial proposal card model", () => {
  const BASE = {
    status: "staged" as const,
    objective: "implement the thing",
    acceptance: ["it works"],
    literalPatchPaths: ["src/a.ts"],
    operation: "implement",
    readOnlyMode: false,
    expiry: "2030-01-01T00:00:00.000Z",
    timeoutMs: 5000,
    maxOutputBytes: 10000,
    requiredChecks: ["lint"],
    workspaceAlias: "ws",
    profile: { configFingerprint: FP, sourceRevision: REV },
    possibleExternalDataConsent: true,
  };

  it("offers Approve/Expire only for a staged proposal on an enabled surface", () => {
    expect(trialProposalModel(BASE, true).decisionVisible).toBe(true);
    expect(
      trialProposalModel({ ...BASE, workspaceAlias: null }, true)
        .decisionVisible,
    ).toBe(false);
    expect(
      trialProposalModel({ ...BASE, profile: null }, true).decisionVisible,
    ).toBe(false);
    expect(
      trialProposalModel({ ...BASE, status: "granted" }, true).decisionVisible,
    ).toBe(false);
    expect(
      trialProposalModel({ ...BASE, status: "expired" }, true).decisionVisible,
    ).toBe(false);
    expect(trialProposalModel(BASE, false).decisionVisible).toBe(false);
  });

  it("renders the frozen snapshot and the disabled state as plain text", () => {
    const model = trialProposalModel(BASE, true);
    expect(model.statusText).toBe(trialStatusText("staged"));
    const joined = model.detailLines.join("\n");
    for (const needle of [
      "implement the thing",
      "it works",
      "src/a.ts",
      "implement",
      "2030-01-01T00:00:00.000Z",
      "5000",
      "10000",
      "lint",
      "ws",
      FP.slice(0, 12),
      REV,
    ]) {
      expect(joined).toContain(needle);
    }
    const unbound = trialProposalModel(
      { ...BASE, workspaceAlias: null, profile: null },
      true,
    );
    expect(unbound.decisionVisible).toBe(false);
    expect(unbound.detailLines.join("\n")).toContain(
      "unbound (cannot approve)",
    );
    expect(trialProposalModel(BASE, false).statusText).toBe(
      "試行の提案は無効です",
    );
    expect(trialStatusText("granted").length).toBeGreaterThan(0);
    expect(trialStatusText("expired").length).toBeGreaterThan(0);
    expect(trialStatusText("invalidated").length).toBeGreaterThan(0);
  });

  // PR-6: the former "serves the trial section in the shell with a strict
  // CSP" test targeted the deleted vanilla shell (`/legacy`). Trials render
  // client-side from the Svelte bundle (TrialsPage.svelte) now; the pure
  // decision/status mapping above is unchanged.
});
