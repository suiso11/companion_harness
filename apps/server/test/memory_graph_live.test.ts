// Live conversation-memory graph regression: REAL remind CLI (temp DB) +
// real migrated in-memory kernel repository. No model, no network.
//
// What this proves (behavioral, no fixture echo):
// - Three linked records written through the REAL CLI (`record.remember`
//   with README `links[]`) appear in the global projection as 3 nodes /
//   2 edges, with opaque mN handles and no raw record ids.
// - Re-opening an unchanged global graph reuses the same searchId/handles
//   (opaque `graph.version` string cache).
// - Local graph around one handle returns the centre + its 2-hop neighbours
//   through the durable graph snapshot (same `searchId`+`handle` binding).
// - Retiring one record changes `graph.version`, so the next global open
//   refetches and reports the retired status (includeRetired).
//
// Prerequisites: same as memory_manage_live.test.ts (real remind CLI at
// `COMPANION_MEMORY_TEST_ENTRY` or sibling `remind/dist/src/cli.js`, plus a
// config template). When absent the suite is SKIPPED, never falsely green.
// Temp stores only; no user DB writes.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { callMemoryCli, type MemoryCliAddress } from "../src/memory_cli.js";
import {
  createMemoryService,
  type MemoryService,
} from "../src/memory_service.js";

const TEST_SCOPE = "personal/default";

function hereDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function siblingRemindPath(...parts: string[]): string {
  return resolve(hereDir(), "..", "..", "..", "..", "remind", ...parts);
}

function tryResolveCliPaths(): { entry: string; template: string } | null {
  const entry =
    process.env.COMPANION_MEMORY_TEST_ENTRY ??
    siblingRemindPath("dist", "src", "cli.js");
  const template =
    process.env.COMPANION_MEMORY_TEST_CONFIG_TEMPLATE ??
    siblingRemindPath("memory.config.example.json");
  if (!existsSync(entry) || !existsSync(template)) {
    return null;
  }
  return { entry, template };
}

function patchRemindConfig(templatePath: string, dir: string): string {
  const raw = readFileSync(templatePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dbPath = join(dir, "remind-graph.db");
  const vaultPath = join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  if (typeof parsed.dbPath === "string") {
    parsed.dbPath = dbPath;
  }
  if (typeof parsed.vaultPath === "string") {
    parsed.vaultPath = vaultPath;
  }
  if (Array.isArray(parsed.allowedScopes)) {
    const scopes = parsed.allowedScopes as unknown[];
    if (!scopes.includes(TEST_SCOPE)) {
      scopes.push(TEST_SCOPE);
    }
  }
  // Existing keys only, and only the ones the graph test does not need.
  const vectors = parsed.vectors as Record<string, unknown> | undefined;
  if (
    vectors !== undefined &&
    typeof vectors === "object" &&
    vectors !== null
  ) {
    if ("enabled" in vectors) {
      vectors.enabled = false;
    }
  }
  const llm = parsed.llm as Record<string, unknown> | undefined;
  if (llm !== undefined && typeof llm === "object" && llm !== null) {
    if ("enabled" in llm) {
      llm.enabled = false;
    }
  }
  const outPath = join(dir, "remind-graph.config.json");
  writeFileSync(outPath, JSON.stringify(parsed), "utf-8");
  return outPath;
}

const CLI_PATHS = tryResolveCliPaths();
const describeLive = CLI_PATHS === null ? describe.skip : describe;

let tempDirs: string[] = [];
let services: MemoryService[] = [];
afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  services = [];
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

async function makeRepo(): Promise<{
  repo: KernelRepository;
  close: () => void;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => closeKernelDatabase(handle),
  };
}

function makeSessionRun(repo: KernelRepository): {
  sessionId: string;
  runId: string;
} {
  const now = Date.now();
  const sessionId = repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "graph live" },
    { key: randomUUID(), now: now + 1 },
  );
  return { sessionId, runId: posted.body.run.id };
}

describeLive("live memory graph (real remind CLI)", () => {
  it("global/local projections, handle reuse, and retire refresh", async (ctx) => {
    if (CLI_PATHS === null) {
      throw new Error("live prerequisite missing");
    }
    const remindDir = mkdtempSync(join(tmpdir(), "remind-live-graph-"));
    tempDirs.push(remindDir);
    const address: MemoryCliAddress = {
      executable: process.execPath,
      entry: CLI_PATHS.entry,
      config: patchRemindConfig(CLI_PATHS.template, remindDir),
      timeoutMs: 10000,
      maxResponseBytes: 65536,
    };
    // Capability probe BEFORE writing fixtures: CI pins a remind revision
    // that predates graph ops, so `graph.version` answers BAD_REQUEST. Skip
    // graph-specific live assertions with an explicit reason instead of
    // failing every job until the pin is bumped after remind#28 merges.
    const probe = await callMemoryCli(
      address,
      "graph.version",
      { scope: TEST_SCOPE },
      undefined,
    ).catch(() => null);
    if (probe !== null && !probe.ok && probe.code === "BAD_REQUEST") {
      console.warn(
        "[memory_graph_live] skipped: pinned remind build has no graph ops (bump after remind#28)",
      );
      ctx.skip();
      return;
    }
    const cli = async (
      op: string,
      params: Record<string, unknown>,
      key?: string,
    ): Promise<Record<string, unknown>> => {
      const envelope = await callMemoryCli(address, op, params, key);
      expect(envelope.ok, `${op} ${envelope.code}`).toBe(true);
      return envelope.data ?? {};
    };

    const provenance = {
      source: "session:graph-live:turn:1",
      observedAt: new Date(Date.now()).toISOString(),
    };
    const remember = async (
      body: string,
      eventId: string,
      links: string[],
    ): Promise<string> => {
      const event = await cli(
        "event.append",
        {
          eventId,
          sessionId: "graph-live",
          turnId: eventId,
          body: `${body} raw`,
          provenance,
          scope: TEST_SCOPE,
        },
        `ev-${eventId}`,
      );
      expect(event).toBeTruthy();
      const data = await cli(
        "record.remember",
        {
          body,
          kind: "user_fact",
          provenance,
          scope: TEST_SCOPE,
          tags: ["graph-live"],
          links,
          sourceRefs: [eventId],
        },
        `rem-${eventId}`,
      );
      const record = data.record as { id?: unknown } | undefined;
      expect(typeof record?.id).toBe("string");
      return record?.id as string;
    };

    const alphaId = await remember("graph-live alpha node", "g-e1", []);
    const betaId = await remember("graph-live beta node", "g-e2", [alphaId]);
    const gammaId = await remember("graph-live gamma node", "g-e3", [betaId]);

    const fixture = await makeRepo();
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      const service = createMemoryService({
        address,
        scope: TEST_SCOPE,
        recallLimit: 5,
        idleMs: 300_000,
        repo: fixture.repo,
        gateway: null,
        model: "live-graph-test",
      });
      services.push(service);

      const first = await service.getMemoryGraphGlobal(sessionId, {
        includeRetired: true,
        runId,
      });
      expect(first.scope).toBe("global");
      expect(first.nodes).toHaveLength(3);
      expect(first.edges).toHaveLength(2);
      // Opaque string version, opaque mN handles, no raw ids in the body.
      expect(typeof first.version).toBe("string");
      expect(first.version.length).toBeGreaterThan(0);
      for (const node of first.nodes) {
        expect(node.handle).toMatch(/^m[1-9][0-9]*$/);
      }
      const serialized = JSON.stringify(first);
      for (const rawId of [alphaId, betaId, gammaId]) {
        expect(serialized).not.toContain(rawId);
      }
      const byLabel = new Map(
        first.nodes.map((node) => [node.label, node] as const),
      );
      const alphaNode = byLabel.get("graph-live alpha node");
      const betaNode = byLabel.get("graph-live beta node");
      const gammaNode = byLabel.get("graph-live gamma node");
      expect(alphaNode).toBeDefined();
      expect(betaNode).toBeDefined();
      expect(gammaNode).toBeDefined();

      // Unchanged reopen reuses the same durable graph search + handles.
      const reopened = await service.getMemoryGraphGlobal(sessionId, {
        includeRetired: true,
        runId,
      });
      expect(reopened.searchId).toBe(first.searchId);
      expect(reopened.nodes.map((node) => node.handle)).toEqual(
        first.nodes.map((node) => node.handle),
      );

      // Local graph around the alpha handle (2 hops reaches gamma).
      const local = await service.getMemoryGraphLocal(sessionId, {
        searchId: first.searchId,
        handle: (alphaNode as { handle: string }).handle,
        depth: 2,
        runId,
      });
      expect(local.scope).toBe("local");
      expect(local.center).toBe((alphaNode as { handle: string }).handle);
      expect(local.nodes).toHaveLength(3);
      expect(local.edges).toHaveLength(2);
      expect(local.version).toBe(first.version);

      // Retire one record through the REAL CLI: the version changes and
      // the next global open reports the retired status.
      const retired = await cli(
        "record.retire",
        { id: betaId, scope: TEST_SCOPE, reasonCode: "NO_LONGER_USEFUL" },
        `retire-${randomUUID()}`,
      );
      expect(retired).toBeTruthy();
      const afterRetire = await service.getMemoryGraphGlobal(sessionId, {
        includeRetired: true,
        runId,
      });
      expect(afterRetire.version).not.toBe(first.version);
      expect(afterRetire.nodes).toHaveLength(3);
      const betaAfter = afterRetire.nodes.find(
        (node) => node.label === "graph-live beta node",
      );
      expect(betaAfter?.status).toBe("retired");
      expect(
        afterRetire.nodes.filter((node) => node.status === "retired"),
      ).toHaveLength(1);
      expect(afterRetire.edges).toHaveLength(2);
    } finally {
      fixture.close();
    }
  }, 120_000);
});
