// Trial proposal/approval HTTP behavioral test (real Hono app + real DB).
//
// Exercises the ACTUAL trial routes end to end (no listener): disabled
// config answers a fixed trials_disabled without touching the DB,
// stage -> approve happy path with the frozen config profile, body
// profile/alias overrides rejected, foreign-session 404s, idempotent
// replay on same key/body with 409 on drift, and GETs that never
// expire/mutate. Plus config parsing and the pure trial card model.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig, ServerConfigError } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import { shellHasNoInlineScript } from "../src/ui/page.js";
import { trialProposalModel, trialStatusText } from "../src/ui/reducer.js";

// Adoption tests spawn a POSIX shell fake gh and use POSIX git setup; the
// adoption feature executes on the Linux host only.
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

const FP = "b".repeat(64);
const REV = "a".repeat(40);

function trialConfigJson(): string {
  return JSON.stringify({
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    configFingerprint: FP,
    sourceRevision: REV,
    sourceRepoPath: "/synthetic/source",
    currentModel: "test-model",
    disclosedWholeRepoRead: true,
    timeoutMs: 60000,
    maxOutputBytes: 1000000,
    workspaceAlias: "ws",
    allowedPaths: ["apps", "packages"],
    modelRoute: "local",
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

async function makeApp(
  withTrial: boolean,
  trialJson?: string,
): Promise<Fixture> {
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
    env.COMPANION_AUTONOMY_JSON = trialJson ?? trialConfigJson();
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
  explicit = true,
  sourceKind: "user" | "self" | "external" = "user",
): { taskId: string } {
  const now = Date.now();
  const goal = repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "ship it",
      kind: "goal",
      explicit,
      sourceKind,
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
    literalPatchPaths: ["apps/a.ts"],
    operation: "implement",
    readOnlyMode: false,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    possibleExternalDataConsent: false,
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

      const adopted = await post(
        app,
        `${base}/${randomUUID()}/adopt`,
        { artifactSha256: "c".repeat(64) },
        randomUUID(),
      );
      expect(adopted.status).toBe(409);
      expect((adopted.body as { error: { code: string } }).error.code).toBe(
        "adoption_disabled",
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

      const profile = await get(
        app,
        `/api/sessions/${sessionId}/trial-profile`,
      );
      expect(profile.status).toBe(404);
      expect((profile.body as { error: { code: string } }).error.code).toBe(
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

describe("trial HTTP profile facts", () => {
  it("returns the frozen form facts and derived read-only operations", async () => {
    const fixture = await makeApp(true);
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;

      const profile = await get(
        app,
        `/api/sessions/${sessionId}/trial-profile`,
      );
      expect(profile.status).toBe(200);
      expect(profile.body).toEqual({
        workspaceAlias: "ws",
        mandatoryChecks: ["lint"],
        allowedPaths: ["apps", "packages"],
        modelRoute: "local",
        ceilings: { timeoutMs: 60000, maxOutputBytes: 1000000 },
        operations: [
          { operation: "investigate", readOnlyMode: true },
          { operation: "implement", readOnlyMode: false },
          { operation: "verify", readOnlyMode: true },
          { operation: "maintenance_trial", readOnlyMode: false },
        ],
      });

      // Unknown query keys fail closed like the other strict trial reads.
      const rejected = await get(
        app,
        `/api/sessions/${sessionId}/trial-profile?extra=1`,
      );
      expect(rejected.status).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("rejects paths outside the frozen profile with a dedicated code", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "pf1");
      const base = `/api/sessions/${sessionId}/trials`;
      for (const path of ["docs/operations.md", "appsx/a.ts"]) {
        const staged = await post(
          app,
          base,
          stageBody(taskId, { literalPatchPaths: [path] }),
          randomUUID(),
        );
        expect(staged.status).toBe(400);
        expect((staged.body as { error: { code: string } }).error.code).toBe(
          "trial_path_outside_profile",
        );
      }
      const traversal = await post(
        app,
        base,
        stageBody(taskId, { literalPatchPaths: ["apps/../x"] }),
        randomUUID(),
      );
      expect(traversal.status).toBe(400);
      for (const path of ["apps", "apps/a.ts", "packages/x/y.ts"]) {
        const staged = await post(
          app,
          base,
          stageBody(taskId, { literalPatchPaths: [path] }),
          randomUUID(),
        );
        expect(staged.status).toBe(201);
      }
    } finally {
      fixture.close();
    }
  });

  it("rejects external consent on the frozen local route", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "pf2");
      const staged = await post(
        app,
        `/api/sessions/${sessionId}/trials`,
        stageBody(taskId, { possibleExternalDataConsent: true }),
        randomUUID(),
      );
      expect(staged.status).toBe(400);
      expect((staged.body as { error: { code: string } }).error.code).toBe(
        "trial_external_consent_unavailable",
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects an external-sourced goal with purpose_not_confirmed", async () => {
    const fixture = await makeApp(true);
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(
        repo,
        sessionId,
        "pf3",
        true,
        "external",
      );
      const staged = await post(
        app,
        `/api/sessions/${sessionId}/trials`,
        stageBody(taskId),
        randomUUID(),
      );
      expect(staged.status).toBe(400);
      expect((staged.body as { error: { code: string } }).error.code).toBe(
        "purpose_not_confirmed",
      );
    } finally {
      fixture.close();
    }
  });
});

describe("task list filters for the staging form", () => {
  it("filters kind/status in SQL before the limit", async () => {
    const fixture = await makeApp(true);
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = Date.now();
      const older = fixture.repo.createAutonomyTask(
        sessionId,
        {
          scope: "default",
          title: "older actionable task",
          kind: "task",
          speaker: "user",
        },
        { key: randomUUID(), now: base },
      );
      for (let index = 0; index < 55; index += 1) {
        fixture.repo.createAutonomyTask(
          sessionId,
          {
            scope: "default",
            title: `chat ${index}`,
            kind: "chat",
            speaker: "user",
          },
          { key: randomUUID(), now: base + index + 1 },
        );
      }

      const unfiltered = await get(app, `/api/sessions/${sessionId}/tasks`);
      expect(unfiltered.status).toBe(200);
      expect(
        (unfiltered.body as { items: { id: string }[] }).items.some(
          (task) => task.id === older.body.id,
        ),
      ).toBe(false);

      const filtered = await get(
        app,
        `/api/sessions/${sessionId}/tasks?kind=task&status=open&limit=10`,
      );
      expect(filtered.status).toBe(200);
      const items = (filtered.body as { items: { id: string }[] }).items;
      expect(items.map((task) => task.id)).toContain(older.body.id);
      expect(items.length).toBeLessThanOrEqual(10);

      const badStatus = await get(
        app,
        `/api/sessions/${sessionId}/tasks?status=unknown`,
      );
      expect(badStatus.status).toBe(400);
      const unknownKey = await get(
        app,
        `/api/sessions/${sessionId}/tasks?kind=task&extra=1`,
      );
      expect(unknownKey.status).toBe(400);
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
      expect(proposal.literalPatchPaths).toEqual(["apps/a.ts"]);
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

      // Schema33 report surface: the bounded sealed report is returned on
      // the trial detail GET with explicit provenance, and never as HTML.
      const rawDb = fixture.db.raw as unknown as {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
      rawDb
        .prepare(
          "INSERT INTO trial_worker_reports (execution_id, session_id, summary, findings_json, unresolved_json, host_diagnostics_json, checks_json, artifact_json, verified, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          executionId,
          sessionId,
          "sealed trial completed",
          JSON.stringify([
            "guest answer (unattested): <img src=x onerror=alert(1)>",
          ]),
          JSON.stringify(["blocked: needs review"]),
          JSON.stringify(["bridge: invalid request"]),
          JSON.stringify([{ name: "lint", outcome: "passed", exit: 0 }]),
          JSON.stringify({ sha256: "c".repeat(64), entryCount: 3 }),
          1,
          1,
        );
      const detail = await get(app, `${base}/${proposalId}`);
      expect(detail.status).toBe(200);
      expect((detail.body as { report: unknown }).report).toMatchObject({
        summary: "sealed trial completed",
        findings: ["guest answer (unattested): <img src=x onerror=alert(1)>"],
        unresolved: ["blocked: needs review"],
        hostDiagnostics: ["bridge: invalid request"],
        checks: [{ name: "lint", outcome: "passed", exit: 0 }],
        artifact: { sha256: "c".repeat(64), entryCount: 3 },
        verified: true,
        provenance: {
          findings: "guest-reported-unattested",
          checks: "host-checked",
          artifact: "host-checked",
          hostDiagnostics: "host-observed",
        },
      });
      const listedWithReport = await get(app, base);
      const firstItem = (
        listedWithReport.body as {
          items: { id: string; reportSummary: string | null }[];
        }
      ).items.find((item) => item.id === proposalId);
      expect(firstItem?.reportSummary).toBe("sealed trial completed");
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
        allowedPaths: ["src", "apps", "packages"],
        modelRoute: "external" as const,
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
            allowedPaths: ["src", "apps", "packages"],
            modelRoute: "external" as const,
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

describe("trial candidate HTTP surface", () => {
  it("serves a verified diff and 404s when no artifact is stored", async () => {
    const root = mkdtempSync(join(tmpdir(), "companion-candidate-http-"));
    const repoPath = join(root, "source");
    mkdirSync(join(repoPath, "apps"), { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      }).trim();
    git(["init", "-q"]);
    writeFileSync(join(repoPath, "apps/a.ts"), "one\n");
    git(["add", "-A"]);
    git([
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    const revision = git(["rev-parse", "HEAD"]);
    const stateDir = join(root, "state");
    const operatorPath = join(root, "operator.json");
    writeFileSync(operatorPath, JSON.stringify({ stateDir }));
    const cfg = JSON.parse(trialConfigJson()) as Record<string, unknown>;
    cfg.sourceRevision = revision;
    cfg.sourceRepoPath = repoPath;
    (cfg.runner as Record<string, unknown>).bridgeConfigTemplatePath =
      operatorPath;
    const fixture = await makeApp(true, JSON.stringify(cfg));
    try {
      const { app } = fixture;
      const rawDb = fixture.db.raw as unknown as {
        prepare: (sql: string) => {
          run: (...args: unknown[]) => void;
          get: (...args: unknown[]) => unknown;
        };
      };
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(fixture.repo, sessionId, "c1");
      const base = `/api/sessions/${sessionId}/trials`;
      const staged = await post(
        app,
        base,
        stageBody(taskId, { literalPatchPaths: ["apps/a.ts"] }),
        randomUUID(),
      );
      expect(staged.status).toBe(201);
      const proposalId = (staged.body as { id: string }).id;
      const approved = await post(
        app,
        `${base}/${proposalId}/approve`,
        {},
        randomUUID(),
      );
      expect(approved.status).toBe(201);
      const executionId = (approved.body as { executionId: string })
        .executionId;
      const grant = rawDb
        .prepare(
          "SELECT approved_profile_json FROM trial_grants WHERE execution_id=?",
        )
        .get(executionId) as { approved_profile_json: string };
      const frozenProfile = JSON.parse(grant.approved_profile_json) as Record<
        string,
        unknown
      >;
      frozenProfile.allowedPaths = ["apps"];
      rawDb
        .prepare(
          "UPDATE trial_grants SET approved_profile_json=? WHERE execution_id=?",
        )
        .run(JSON.stringify(frozenProfile), executionId);
      const runDir = join(stateDir, "runs", executionId);
      mkdirSync(join(runDir, "candidate/apps"), { recursive: true });
      writeFileSync(join(runDir, "candidate/apps/a.ts"), "two\n");
      const artifact = Buffer.from(
        `${JSON.stringify({
          schemaVersion: 2,
          executionId,
          taskHash: "f".repeat(64),
          baseManifestDigest: "d".repeat(64),
          profileFingerprint: FP,
          sourceRevision: revision,
          changeCount: 1,
          changes: [
            {
              path: "apps/a.ts",
              kind: "modify",
              baseSha256:
                "929b1c4a2a6b1e2d7c3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9",
              baseMode: 0o100644,
              candidateSha256: "0".repeat(64),
              candidateMode: 0o100644,
              size: 4,
            },
          ],
        })}\n`,
      );
      // Use the real hashes the server will recompute.
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const doc = JSON.parse(artifact.toString("utf8")) as {
        changes: Record<string, unknown>[];
      };
      const change = doc.changes[0];
      if (change === undefined) throw new Error("fixture change missing");
      change.baseSha256 = hash("one\n");
      change.candidateSha256 = hash("two\n");
      const artifactBytes = Buffer.from(`${JSON.stringify(doc)}\n`);
      writeFileSync(join(runDir, "artifact.json"), artifactBytes);
      rawDb
        .prepare(
          "INSERT INTO trial_worker_reports (execution_id, session_id, summary, findings_json, unresolved_json, host_diagnostics_json, checks_json, artifact_json, verified, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          executionId,
          sessionId,
          "done",
          "[]",
          "[]",
          "[]",
          "[]",
          JSON.stringify({
            sha256: hash(artifactBytes.toString("utf8")),
            entryCount: 1,
          }),
          1,
          1,
        );
      const candidate = await get(app, `${base}/${proposalId}/candidate`);
      expect(candidate.status).toBe(200);
      expect(candidate.body).toMatchObject({
        available: true,
        truncated: false,
        changes: [
          { path: "apps/a.ts", kind: "modify", size: 4, modeChanged: false },
        ],
      });
      expect((candidate.body as { diff: string }).diff).toContain("+two");
      // A frozen scope that does not cover the change must fail closed even
      // though the current template allows it.
      frozenProfile.allowedPaths = ["packages"];
      rawDb
        .prepare(
          "UPDATE trial_grants SET approved_profile_json=? WHERE execution_id=?",
        )
        .run(JSON.stringify(frozenProfile), executionId);
      const outOfScope = await get(app, `${base}/${proposalId}/candidate`);
      expect(outOfScope.status).toBe(200);
      expect(outOfScope.body).toMatchObject({
        available: false,
        code: "candidate_unavailable",
      });
      // Legacy grants (null frozen profile) fall back to the current template.
      rawDb
        .prepare(
          "UPDATE trial_grants SET approved_profile_json=NULL WHERE execution_id=?",
        )
        .run(executionId);
      const legacy = await get(app, `${base}/${proposalId}/candidate`);
      expect(legacy.body).toMatchObject({ available: true });
      rawDb
        .prepare("DELETE FROM trial_worker_reports WHERE execution_id=?")
        .run(executionId);
      const missing = await get(app, `${base}/${proposalId}/candidate`);
      expect(missing.status).toBe(404);
    } finally {
      fixture.close();
    }
  });
});

posixDescribe("trial adoption HTTP surface", () => {
  let root: string;
  let remote: string;
  let checkout: string;
  let bin: string;
  let ghCalls: string;
  let operatorPath: string;
  let revision: string;
  let originalPath: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "companion-adoption-http-"));
    remote = join(root, "remote.git");
    checkout = join(root, "checkout");
    bin = join(root, "bin");
    ghCalls = join(root, "gh-calls");
    operatorPath = join(root, "operator.json");
    writeFileSync(ghCalls, "");
    writeFileSync(
      operatorPath,
      JSON.stringify({ stateDir: join(root, "state") }),
    );
    mkdirSync(bin);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", checkout]);
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    git(["config", "user.name", "test"]);
    git(["config", "user.email", "test@example.com"]);
    mkdirSync(join(checkout, "apps"), { recursive: true });
    writeFileSync(join(checkout, "apps/a.ts"), "one\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["branch", "-M", "master"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-q", "origin", "master"]);
    revision = git(["rev-parse", "HEAD"]);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghCalls}'\nprintf 'https://github.com/example/repo/pull/42\\n'\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  });

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
  });

  function adoptionCfg(): string {
    const cfg = JSON.parse(trialConfigJson()) as Record<string, unknown>;
    cfg.sourceRevision = revision;
    cfg.sourceRepoPath = checkout;
    const runner = cfg.runner as Record<string, unknown>;
    runner.bridgeConfigTemplatePath = operatorPath;
    cfg.adoption = {
      repoPath: checkout,
      remote: "origin",
      baseRef: "origin/master",
      branchPrefix: "trial/",
    };
    return JSON.stringify(cfg);
  }

  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  async function prepareAdoptable(
    fixture: Fixture,
    scope: string,
  ): Promise<{
    base: string;
    sessionId: string;
    proposalId: string;
    executionId: string;
    artifactSha: string;
  }> {
    const { app, repo } = fixture;
    const created = await post(app, "/api/sessions", {}, randomUUID());
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const { taskId } = stageAuthority(repo, sessionId, scope);
    const base = `/api/sessions/${sessionId}/trials`;
    const staged = await post(
      app,
      base,
      stageBody(taskId, { literalPatchPaths: ["apps/a.ts"] }),
      randomUUID(),
    );
    expect(staged.status).toBe(201);
    const proposalId = (staged.body as { id: string }).id;
    const approved = await post(
      app,
      `${base}/${proposalId}/approve`,
      {},
      randomUUID(),
    );
    expect(approved.status).toBe(201);
    const executionId = (approved.body as { executionId: string }).executionId;
    const rawDb = fixture.db.raw as unknown as {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => void;
        get: (...args: unknown[]) => unknown;
      };
    };
    const grant = rawDb
      .prepare(
        "SELECT approved_profile_json FROM trial_grants WHERE execution_id=?",
      )
      .get(executionId) as { approved_profile_json: string };
    const frozen = JSON.parse(grant.approved_profile_json) as Record<
      string,
      unknown
    >;
    frozen.allowedPaths = ["apps"];
    rawDb
      .prepare(
        "UPDATE trial_grants SET approved_profile_json=? WHERE execution_id=?",
      )
      .run(JSON.stringify(frozen), executionId);
    const stateDir = join(root, "state");
    const runDir = join(stateDir, "runs", executionId);
    mkdirSync(join(runDir, "candidate/apps"), { recursive: true });
    writeFileSync(join(runDir, "candidate/apps/a.ts"), "two\n");
    const artifactBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 2,
        executionId,
        taskHash: "f".repeat(64),
        baseManifestDigest: "d".repeat(64),
        profileFingerprint: FP,
        sourceRevision: revision,
        changeCount: 1,
        changes: [
          {
            path: "apps/a.ts",
            kind: "modify",
            baseSha256: hash("one\n"),
            baseMode: 0o100644,
            candidateSha256: hash("two\n"),
            candidateMode: 0o100644,
            size: 4,
          },
        ],
      })}\n`,
    );
    writeFileSync(join(runDir, "artifact.json"), artifactBytes);
    rawDb
      .prepare(
        "INSERT INTO trial_worker_reports (execution_id, session_id, summary, findings_json, unresolved_json, host_diagnostics_json, checks_json, artifact_json, verified, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        executionId,
        sessionId,
        "done",
        "[]",
        "[]",
        "[]",
        "[]",
        JSON.stringify({
          sha256: hash(artifactBytes.toString("utf8")),
          entryCount: 1,
        }),
        1,
        1,
      );
    rawDb
      .prepare("UPDATE trial_grants SET status='consumed' WHERE execution_id=?")
      .run(executionId);
    return {
      base,
      sessionId,
      proposalId,
      executionId,
      artifactSha: hash(artifactBytes.toString("utf8")),
    };
  }

  it("adopts on a human click and replays the same result once", async () => {
    const fixture = await makeApp(true, adoptionCfg());
    try {
      const { base, sessionId, proposalId, executionId, artifactSha } =
        await prepareAdoptable(fixture, "ad1");
      const key = randomUUID();
      const first = await post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: artifactSha },
        key,
      );
      expect(first.status).toBe(201);
      const branch = `trial/${executionId.slice(0, 8)}`;
      const commitSha = execFileSync(
        "git",
        ["-C", remote, "rev-parse", `refs/heads/${branch}`],
        { encoding: "utf8" },
      ).trim();
      expect(first.body).toMatchObject({
        status: "done",
        branch,
        prUrl: "https://github.com/example/repo/pull/42",
        commitSha,
        errorCode: null,
      });
      // The user is told in their own chat exactly once, with the PR link.
      const notices = fixture.repo.listCompanionMessagesForward(sessionId, {
        after: 0,
        limit: 50,
      }).messages;
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain(
        "https://github.com/example/repo/pull/42",
      );
      expect(notices[0]?.text).toContain(branch);
      const second = await post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: artifactSha },
        key,
      );
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      // A replay never re-announces the same PR.
      expect(
        fixture.repo.listCompanionMessagesForward(sessionId, {
          after: 0,
          limit: 50,
        }).messages,
      ).toHaveLength(1);
      // The executor (gh) ran exactly once across both clicks (the PR body
      // itself spans lines, so count invocations, not file lines).
      const calls = readFileSync(ghCalls, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("pr create "));
      expect(calls).toHaveLength(1);
      const detail = await get(fixture.app, `${base}/${proposalId}`);
      expect(detail.status).toBe(200);
      expect((detail.body as { adoption: unknown }).adoption).toEqual({
        status: "done",
        branch,
        prUrl: "https://github.com/example/repo/pull/42",
        commitSha,
        errorCode: null,
      });
    } finally {
      fixture.close();
    }
  });

  it("replays a done adoption after retention pruned the artifact", async () => {
    const fixture = await makeApp(true, adoptionCfg());
    try {
      const { base, proposalId, executionId, artifactSha } =
        await prepareAdoptable(fixture, "ad3");
      const key = randomUUID();
      const first = await post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: artifactSha },
        key,
      );
      expect(first.status).toBe(201);
      // Retention is pruned after done: the durable adoption row must still
      // replay without loading or verifying the now-missing artifact.
      rmSync(join(root, "state", "runs", executionId), {
        recursive: true,
        force: true,
      });
      const replay = await post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: artifactSha },
        key,
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
    } finally {
      fixture.close();
    }
  });

  it("drains a started adoption before the DB can close", async () => {
    const fixture = await makeApp(true, adoptionCfg());
    const marker = join(root, "slow-gh-started");
    try {
      const { base, proposalId, artifactSha } = await prepareAdoptable(
        fixture,
        "ad4",
      );
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\ntouch '${marker}'\nsleep 0.5\nprintf 'https://github.com/example/repo/pull/42\\n'\n`,
        { mode: 0o755 },
      );
      const pending = post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: artifactSha },
        randomUUID(),
      );
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error("adoption never started");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let drained = false;
      const drain = fixture.controls.drainTrialAdoptions().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The push/PR is still in flight, so drain must not resolve yet.
      expect(drained).toBe(false);
      const adopted = await pending;
      expect(adopted.status).toBe(201);
      await drain;
      expect(drained).toBe(true);
      // The handler's DB finish happened before drain returned.
      const detail = await get(fixture.app, `${base}/${proposalId}`);
      expect(
        (detail.body as { adoption: { status: string } }).adoption.status,
      ).toBe("done");
    } finally {
      rmSync(marker, { force: true });
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghCalls}'\nprintf 'https://github.com/example/repo/pull/42\\n'\n`,
        { mode: 0o755 },
      );
      fixture.close();
    }
  });

  it("rejects a wrong artifact digest with 409 and pushes nothing", async () => {
    const fixture = await makeApp(true, adoptionCfg());
    try {
      const { base, proposalId } = await prepareAdoptable(fixture, "ad2");
      const callsBefore = readFileSync(ghCalls, "utf8").trim().split("\n");
      const mismatch = await post(
        fixture.app,
        `${base}/${proposalId}/adopt`,
        { artifactSha256: "c".repeat(64) },
        randomUUID(),
      );
      expect(mismatch.status).toBe(409);
      expect((mismatch.body as { error: { code: string } }).error.code).toBe(
        "artifact_mismatch",
      );
      expect(readFileSync(ghCalls, "utf8").trim().split("\n")).toEqual(
        callsBefore,
      );
    } finally {
      fixture.close();
    }
  });

  it("settles stale pending adoptions on read and recovers on boot", async () => {
    const fixture = await makeApp(true);
    try {
      const rawDb = fixture.db.raw as unknown as {
        prepare: (sql: string) => {
          run: (...args: unknown[]) => void;
        };
      };
      const insertPending = (
        proposalId: string,
        executionId: string,
        at: number,
      ) =>
        rawDb
          .prepare(
            "INSERT INTO trial_adoptions (proposal_id, execution_id, artifact_sha256, status, branch, pr_url, error_code, created_at, updated_at) VALUES (?,?,?, 'pending', NULL, NULL, NULL, ?, ?)",
          )
          .run(proposalId, executionId, "a".repeat(64), at, at);

      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const { taskId } = stageAuthority(repo, sessionId, "rec1");
      const base = `/api/sessions/${sessionId}/trials`;
      const stageOne = async () => {
        const staged = await post(
          app,
          base,
          stageBody(taskId, { literalPatchPaths: ["apps/a.ts"] }),
          randomUUID(),
        );
        const proposalId = (staged.body as { id: string }).id;
        const approved = await post(
          app,
          `${base}/${proposalId}/approve`,
          {},
          randomUUID(),
        );
        return {
          proposalId,
          executionId: (approved.body as { executionId: string }).executionId,
        };
      };
      const stale = await stageOne();
      insertPending(
        stale.proposalId,
        stale.executionId,
        Date.now() - 16 * 60 * 1000,
      );
      const staleRead = await get(app, `${base}/${stale.proposalId}`);
      expect(
        (staleRead.body as { adoption: { status: string } }).adoption.status,
      ).toBe("failed");
      expect(
        (staleRead.body as { adoption: { errorCode: string } }).adoption
          .errorCode,
      ).toBe("interrupted");

      const fresh = await stageOne();
      insertPending(fresh.proposalId, fresh.executionId, Date.now());
      const freshRead = await get(app, `${base}/${fresh.proposalId}`);
      expect(
        (freshRead.body as { adoption: { status: string } }).adoption.status,
      ).toBe("pending");
      // Boot recovery settles every pending row of the previous process.
      expect(repo.recoverInterruptedTrialAdoptions()).toBe(1);
      const afterBoot = await get(app, `${base}/${fresh.proposalId}`);
      expect((afterBoot.body as { adoption: unknown }).adoption).toMatchObject({
        status: "failed",
        branch: null,
        prUrl: null,
        errorCode: "interrupted",
      });
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
    // The sealed snapshot root must be a platform-absolute path.
    const relativeSource = { ...full, sourceRepoPath: "relative/source" };
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_AUTONOMY_JSON: JSON.stringify(relativeSource),
        COMPANION_MODEL_JSON: trialModelJson(),
      }),
    ).toThrow("trial config source repository path is invalid");
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

  it("serves the trial section in the shell with a strict CSP", async () => {
    const fixture = await makeApp(true);
    try {
      // PR-1: the full panels (trials included) live in the vanilla shell
      // at `/legacy` until PR-5 moves them to their own routes.
      const response = await fixture.app.request("/legacy", {
        method: "GET",
        headers: { host: "127.0.0.1" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="trials"');
      expect(html).toContain('id="trial-list"');
      expect(html).toContain('id="trial-approve-button"');
      expect(html).toContain('id="trial-expire-button"');
      expect(shellHasNoInlineScript(html)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
