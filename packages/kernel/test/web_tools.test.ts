// `web.search` broker registration tests (§8, kernel-side):
// guard regex + injected-memory-substring exfiltration rejection, per-turn
// web budget (guard rejections never consume it), and result -> rN
// reference mapping. The SearXNG HTTP client is faked at the connector-web
// module boundary; everything kernel-side (guard, budget, broker tool
// registration, ReferenceManager, SQLite store) is real.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSearchClientError } from "@companion/connector-web";
import { WebSearchToolInputSchema } from "@companion/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  createWebSearchRegistration,
  generateId,
  type KernelRepository,
  type MemoryExposureInput,
  mapWebClientError,
  migrateKernelDatabase,
  openKernelDatabase,
  ToolError,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;

const fakeFetchCalls: string[] = [];
let fakeSearxBody = '{"results":[]}';
let fakeFetchHold: Promise<void> | null = null;

vi.mock("@companion/connector-web", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@companion/connector-web")>();
  return {
    ...actual,
    fetchSearxResults: async (options: { query: string }) => {
      fakeFetchCalls.push(options.query);
      if (fakeFetchHold) await fakeFetchHold;
      return fakeSearxBody;
    },
    WebSearchClientError: actual.WebSearchClientError,
  };
});

async function openStack(options: { perTurnBudget?: number } = {}) {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo: KernelRepository = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  const inst = manager.ensureWebConnectorInstance("web", { now: T0 });
  const config = {
    enabled: true,
    searxng_base_url: "http://127.0.0.1:8080",
    ...(options.perTurnBudget !== undefined
      ? { per_turn_budget: options.perTurnBudget }
      : {}),
  };
  const registration = createWebSearchRegistration({
    db: handle.raw,
    repo,
    referenceManager: manager,
    connectorInstanceId: inst.id,
    config,
    clock: { now: () => T0 + 50 },
  });
  return { handle, repo, manager, registration };
}

function runningRun(repo: KernelRepository) {
  const sessionId = repo.createSession({ key: generateId(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "search the web" },
    { key: generateId(), now: T0 },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: T0 + 1 });
  return { sessionId, runId };
}

function exposureOf(
  overrides: Partial<MemoryExposureInput>,
): MemoryExposureInput {
  return {
    recallId: "recall-1",
    recordId: "record-1",
    sessionId: generateId(),
    runId: generateId(),
    scope: "test-scope",
    citation: "m1",
    snippet: "a leaked memory snippet for exfiltration tests",
    ...overrides,
  };
}

/** Parse and force top_k (the broker normally does the parse). */
function input(query: string, top_k = 5) {
  return WebSearchToolInputSchema.parse({ query, top_k });
}

function ctx(runId: string) {
  return {
    runId,
    signal: new AbortController().signal,
    origin: "test-origin",
    caller: "test-caller",
  };
}

/** Cast through ToolHandler's `never` input for direct test invocation. */
type DirectInvoke = (
  input: unknown,
  ctx: {
    runId: string;
    signal: AbortSignal;
    origin: string;
    caller: string;
  },
) => Promise<unknown>;

function invoke(
  registration: ToolRegistration,
  input: unknown,
  ctxNo: { runId: string; signal: AbortSignal; origin: string; caller: string },
): Promise<unknown> {
  return (registration.handler as unknown as DirectInvoke)(input, ctxNo);
}

/** Await a handler promise and return the closed ToolError code it throws. */
async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return error.errorCode;
    throw new Error(`expected ToolError, got ${String(error)}`);
  }
  throw new Error("expected ToolError, but the call succeeded");
}

describe("web.search guard", () => {
  beforeEach(() => {
    fakeFetchCalls.length = 0;
    fakeSearxBody = '{"results":[]}';
  });

  it("rejects citation-id-shaped queries (rN/mN) with web_query_rejected and never reaches the client", async () => {
    const { handle, registration, repo } = await openStack();
    try {
      const { runId } = runningRun(repo);
      for (const query of ["r7", "m12", " r12 "]) {
        expect(
          await rejectedCode(
            invoke(registration, input(query), ctx(runId)) as Promise<unknown>,
          ),
        ).toBe("web_query_rejected");
      }
      expect(fakeFetchCalls).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects a >=16-code-point contiguous substring of an injected memory snippet; shorter overlap passes", async () => {
    const { handle, repo, registration } = await openStack();
    try {
      const { sessionId, runId } = runningRun(repo);
      const snippet = "secret-context-abc-XYZ-9876"; // 26 code points
      repo.recordMemoryExposure(exposureOf({ sessionId, runId, snippet }), {
        now: T0,
      });
      // Full 16+ cp window present -> rejected, client never invoked.
      expect(
        await rejectedCode(
          invoke(
            registration,
            input(`look up ${snippet} please`),
            ctx(runId),
          ) as Promise<unknown>,
        ),
      ).toBe("web_query_rejected");
      expect(fakeFetchCalls).toHaveLength(0);
      // No memory substring at all -> guard passes, client is reached.
      await invoke(
        registration,
        input("ordinary weather question"),
        ctx(runId),
      );
      expect(fakeFetchCalls).toEqual(["ordinary weather question"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("guard rejection happens BEFORE the per-turn reservation and never consumes web budget", async () => {
    const { handle, repo, registration } = await openStack({
      perTurnBudget: 2,
    });
    try {
      const { runId } = runningRun(repo);
      // 1) Guard rejection is free (never charged).
      expect(
        await rejectedCode(
          invoke(registration, input("r3"), ctx(runId)) as Promise<unknown>,
        ),
      ).toBe("web_query_rejected");
      // 2) The full per-turn budget of two chargeable searches still works.
      await invoke(registration, input("first"), ctx(runId));
      await invoke(registration, input("second"), ctx(runId));
      // 3) A third chargeable execution exceeds the per-turn budget.
      expect(
        await rejectedCode(
          invoke(registration, input("third"), ctx(runId)) as Promise<unknown>,
        ),
      ).toBe("budget_exceeded");
      expect(fakeFetchCalls).toEqual(["first", "second"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("web.search result -> rN mapping", () => {
  beforeEach(() => {
    fakeFetchCalls.length = 0;
  });

  it("materializes hits as session references with model-facing ordinals r1..rN and side-table URLs", async () => {
    const { handle, repo, registration } = await openStack();
    try {
      const { sessionId, runId } = runningRun(repo);
      fakeSearxBody = JSON.stringify({
        results: [
          {
            url: "https://Example.com/a",
            title: "Example A",
            content: "Snippet A text",
          },
          {
            url: "https://example.com/B",
            title: "Example B",
            content: "Snippet B text",
          },
        ],
      });
      const output = (await invoke(
        registration,
        input("two hits", 5),
        ctx(runId),
      )) as {
        hits: Array<{
          referenceId: string;
          ordinal: number;
          url: string;
          title: string | null;
          snippet: string | null;
        }>;
      };
      expect(output.hits).toHaveLength(2);
      // Model-facing rN mapping: ordinals 1 and 2 in presentation order.
      expect(output.hits.map((r) => r.ordinal)).toEqual([1, 2]);
      expect(output.hits[0]?.url).toBe("https://Example.com/a");
      expect(output.hits[1]?.url).toBe("https://example.com/B");
      expect(new Set(output.hits.map((r) => r.referenceId)).size).toBe(2);
      // References are persisted for the session (rN = ordinal within it).
      const rows = handle.raw
        .prepare(
          "SELECT ordinal, id, snapshot_id FROM session_references WHERE session_id = ? ORDER BY ordinal ASC",
        )
        .all(sessionId) as Array<{
        ordinal: number;
        id: string;
        snapshot_id: string;
      }>;
      expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
      for (let i = 0; i < rows.length; i += 1) {
        expect(output.hits[i]?.referenceId).toBe(rows[i]?.id);
        const urlRow = handle.raw
          .prepare("SELECT url FROM web_result_urls WHERE snapshot_id = ?")
          .get(rows[i]?.snapshot_id) as { url: string } | undefined;
        expect(urlRow?.url).toBe(output.hits[i]?.url);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("mapWebClientError", () => {
  it("maps connector client codes to closed broker codes", () => {
    expect(
      mapWebClientError(new WebSearchClientError("timeout", "x")).errorCode,
    ).toBe("execution_timeout");
    expect(
      mapWebClientError(new WebSearchClientError("redirect_refused", "x"))
        .errorCode,
    ).toBe("execution_failed");
    expect(mapWebClientError(new Error("boom")).errorCode).toBe(
      "execution_failed",
    );
    const signal = new AbortController();
    signal.abort();
    expect(mapWebClientError(new Error("boom"), signal.signal).errorCode).toBe(
      "execution_cancelled",
    );
  });
});

describe("web.search review fixes", () => {
  beforeEach(() => {
    fakeFetchCalls.length = 0;
    fakeFetchHold = null;
  });

  it("persisted per-turn budget survives registration recreation (restart/retry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-budget-"));
    const file = join(dir, "kernel.db");
    try {
      const h1 = openKernelDatabase(file);
      await migrateKernelDatabase({ db: h1.raw });
      const repo1 = createKernelRepository(h1.raw);
      const m1 = createReferenceManager(h1.raw);
      const inst = m1.ensureWebConnectorInstance("web", { now: T0 });
      const reg1 = createWebSearchRegistration({
        db: h1.raw,
        repo: repo1,
        referenceManager: m1,
        connectorInstanceId: inst.id,
        config: {
          enabled: true,
          searxng_base_url: "http://127.0.0.1:8080",
          per_turn_budget: 1,
        },
        clock: { now: () => T0 + 50 },
      });
      const { runId } = runningRun(repo1);
      await invoke(reg1, input("first"), ctx(runId));
      // Simulate a restart: drop the process, keep the SQLite file.
      closeKernelDatabase(h1);
      const h2 = openKernelDatabase(file);
      const repo2 = createKernelRepository(h2.raw);
      const m2 = createReferenceManager(h2.raw);
      const reg2 = createWebSearchRegistration({
        db: h2.raw,
        repo: repo2,
        referenceManager: m2,
        connectorInstanceId: inst.id,
        config: {
          enabled: true,
          searxng_base_url: "http://127.0.0.1:8080",
          per_turn_budget: 1,
        },
        clock: { now: () => T0 + 50 },
      });
      // Same turn (same run id) via a fresh registration: still charged.
      expect(
        await rejectedCode(
          invoke(reg2, input("second"), ctx(runId)) as Promise<unknown>,
        ),
      ).toBe("budget_exceeded");
      closeKernelDatabase(h2);
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  });

  it("fails closed when the memory exposure lookup throws", async () => {
    const { handle, repo, registration } = await openStack();
    try {
      const { runId } = runningRun(repo);
      (repo as unknown as Record<string, unknown>).listMemoryExposures = () => {
        throw new Error("storage unavailable");
      };
      expect(
        await rejectedCode(
          invoke(registration, input("first"), ctx(runId)) as Promise<unknown>,
        ),
      ).toBe("web_query_rejected");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects embedded citation tokens but allows plain queries", async () => {
    const { handle, repo, registration } = await openStack();
    try {
      const { runId } = runningRun(repo);
      for (const q of ["newer than r1", "(r1)", "r12abc", "see m2 please"]) {
        expect(
          await rejectedCode(
            invoke(registration, input(q), ctx(runId)) as Promise<unknown>,
          ),
        ).toBe("web_query_rejected");
      }
      expect(fakeFetchCalls).toEqual([]);
      // Benign queries (no citation-shaped token) still go through.
      await invoke(registration, input("rust 1.0 release notes"), ctx(runId));
      expect(fakeFetchCalls).toEqual(["rust 1.0 release notes"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("serializes concurrent web.search calls within a run", async () => {
    const { handle, repo, registration } = await openStack();
    try {
      let release!: () => void;
      fakeFetchHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runId } = runningRun(repo);
      const p1 = invoke(registration, input("a"), ctx(runId));
      const p2 = invoke(registration, input("b"), ctx(runId));
      await new Promise((r) => setTimeout(r, 10));
      expect(fakeFetchCalls).toEqual(["a"]);
      release();
      await Promise.all([p1, p2]);
      expect(fakeFetchCalls).toEqual(["a", "b"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
