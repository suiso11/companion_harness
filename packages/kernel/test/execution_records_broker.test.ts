// Broker private execution-recording behavior: the raw handler settlement is
// captured at the actual handler boundary (before normalization/output-schema
// validation), detached successes/errors are recorded as discarded with the
// same private call identity, and recorder failures stay explicit without
// erasing the public metadata audit.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createExecutionRecordStore,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  ToolError,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1_790_000_000_000;
const CTX = { origin: "test-origin", caller: "test-caller" };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "broker-records-"));
  roots.push(root);
  return createExecutionRecordStore({
    directory: join(root, "private"),
    clock: { now: () => T0 },
  });
}

type Handle = ReturnType<typeof openKernelDatabase>;

async function setup(): Promise<{ handle: Handle; repo: KernelRepository }> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, repo: createKernelRepository(handle.raw) };
}

function newRunningRun(repo: KernelRepository): {
  sessionId: string;
  runId: string;
} {
  const sessionId = repo.createSession({
    key: crypto.randomUUID(),
    now: T0,
  }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "fixed task" },
    { key: crypto.randomUUID(), now: T0 },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: T0 + 1 });
  return { sessionId, runId };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function registration(overrides: {
  handler: ToolRegistration["handler"];
  outputSchema?: ToolRegistration["outputSchema"];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}): ToolRegistration {
  return {
    descriptor: {
      name: "test.read",
      version: 1,
      title: "Read",
      description: "Read fixed evidence",
      category: "read",
      defaultTimeoutMs: overrides.defaultTimeoutMs ?? 5000,
      maxTimeoutMs: overrides.maxTimeoutMs ?? 10_000,
      supportsRefresh: false,
    },
    inputSchema: z.strictObject({ q: z.string() }),
    outputSchema:
      overrides.outputSchema ?? z.strictObject({ text: z.string() }),
    handler: overrides.handler,
  };
}

function makeBroker(
  handle: Handle,
  repo: KernelRepository,
  reg: ToolRegistration,
  recorder: Parameters<typeof createToolBroker>[0]["executionRecorder"],
) {
  return createToolBroker({
    db: handle.raw,
    repo,
    registrations: [reg],
    ...(recorder === undefined ? {} : { executionRecorder: recorder }),
  });
}

function toolRow(handle: Handle, runId: string) {
  return handle.raw
    .prepare(
      "SELECT actual_outcome, reported_outcome, result_disposition, error_code FROM tool_calls WHERE run_id = ?",
    )
    .get(runId) as
    | {
        actual_outcome: string;
        reported_outcome: string | null;
        result_disposition: string;
        error_code: string | null;
      }
    | undefined;
}

function runEvents(handle: Handle, runId: string) {
  return handle.raw
    .prepare(
      "SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq",
    )
    .all(runId) as Array<{ type: string; payload: string }>;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("broker private execution recording", () => {
  it("records the raw handler value before output-schema rejection", async () => {
    const recorder = tempStore();
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo);
      const broker = makeBroker(
        handle,
        repo,
        registration({
          handler: async () => ({ unexpected: "raw-invalid" }),
        }),
        recorder,
      );
      const out = await broker.invoke(runId, "test.read", { q: "x" }, CTX);
      expect(out.result).toMatchObject({
        actualOutcome: "failed",
        reportedOutcome: "succeeded",
        disposition: "none",
        errorCode: "output_invalid",
      });

      const records = recorder.exportRun(runId);
      const input = records.find((record) => record.kind === "tool.input");
      const raw = records.find(
        (record) => record.kind === "tool.handler.result",
      );
      const final = records.find((record) => record.kind === "tool.result");
      expect(input).toBeDefined();
      expect(raw?.callId).toBe(input?.callId);
      expect(raw?.data).toEqual({
        tool: "test.read",
        raw: { unexpected: "raw-invalid" },
        disposition: "none",
        detached: false,
      });
      expect(final?.callId).toBe(input?.callId);
      expect(final?.data).toMatchObject({
        tool: "test.read",
        result: {
          actualOutcome: "failed",
          errorCode: "output_invalid",
        },
      });
    } finally {
      handle.raw.close();
    }
  });

  it("records a late detached success as discarded without a post-terminal event", async () => {
    const recorder = tempStore();
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo);
      const started = deferred();
      const finish = deferred();
      const broker = makeBroker(
        handle,
        repo,
        registration({
          handler: async () => {
            started.resolve();
            await finish.promise;
            return { text: "late-raw-value" };
          },
        }),
        recorder,
      );
      const controller = new AbortController();
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "late" },
        {
          ...CTX,
          signal: controller.signal,
        },
      );
      await started.promise;
      controller.abort();
      const out = await pending;
      expect(out.result).toMatchObject({
        actualOutcome: "cancelled",
        disposition: "none",
      });

      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      repo.finalizeCancelRequested(runId, { now: T0 + 6 });
      const terminalEvents = runEvents(handle, runId).length;
      finish.resolve();
      await waitFor(() =>
        recorder
          .exportRun(runId)
          .some((record) => record.kind === "tool.handler.result"),
      );

      const records = recorder.exportRun(runId);
      const input = records.find((record) => record.kind === "tool.input");
      const raw = records.find(
        (record) => record.kind === "tool.handler.result",
      );
      expect(raw?.callId).toBe(input?.callId);
      expect(raw?.data).toEqual({
        tool: "test.read",
        raw: { text: "late-raw-value" },
        disposition: "discarded",
        detached: true,
      });
      expect(toolRow(handle, runId)).toMatchObject({
        actual_outcome: "cancelled",
        reported_outcome: "succeeded",
        result_disposition: "discarded",
      });
      expect(runEvents(handle, runId).length).toBe(terminalEvents);
    } finally {
      handle.raw.close();
    }
  });

  it("records a late detached error as discarded with bounded credential filtering", async () => {
    const recorder = tempStore();
    const { handle, repo } = await setup();
    const secret = "SECRET-BROKER-OUTCOME";
    try {
      const { sessionId, runId } = newRunningRun(repo);
      const started = deferred();
      const finish = deferred();
      const broker = makeBroker(
        handle,
        repo,
        registration({
          handler: async () => {
            started.resolve();
            await finish.promise;
            throw new ToolError(
              "execution_failed",
              `provider failed: Authorization: Bearer ${secret}`,
            );
          },
        }),
        recorder,
      );
      const controller = new AbortController();
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "late" },
        {
          ...CTX,
          signal: controller.signal,
        },
      );
      await started.promise;
      controller.abort();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");

      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      repo.finalizeCancelRequested(runId, { now: T0 + 6 });
      const terminalEvents = runEvents(handle, runId);
      finish.resolve();
      await waitFor(() =>
        recorder
          .exportRun(runId)
          .some((record) => record.kind === "tool.handler.error"),
      );

      const records = recorder.exportRun(runId);
      const input = records.find((record) => record.kind === "tool.input");
      const rawError = records.find(
        (record) => record.kind === "tool.handler.error",
      );
      expect(rawError?.callId).toBe(input?.callId);
      expect(rawError?.data).toMatchObject({
        tool: "test.read",
        errorCode: "execution_failed",
        disposition: "discarded",
        detached: true,
      });
      expect(JSON.stringify(rawError)).not.toContain(secret);
      expect(toolRow(handle, runId)).toMatchObject({
        actual_outcome: "cancelled",
        reported_outcome: "failed",
        result_disposition: "discarded",
      });
      expect(runEvents(handle, runId)).toEqual(terminalEvents);
      expect(JSON.stringify(terminalEvents)).not.toContain(secret);
      expect(JSON.stringify(toolRow(handle, runId))).not.toContain(secret);
    } finally {
      handle.raw.close();
    }
  });

  it("fails the active invocation explicitly when a settlement record cannot be written", async () => {
    const recorder = tempStore();
    const failing = {
      record(input: Parameters<typeof recorder.record>[0]): void {
        if (input.kind === "tool.handler.result") {
          throw new Error("disk full");
        }
        recorder.record(input);
      },
    };
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo);
      const broker = makeBroker(
        handle,
        repo,
        registration({
          handler: async (input: { q: string }) => ({ text: input.q }),
        }),
        failing,
      );
      await expect(
        broker.invoke(runId, "test.read", { q: "ok" }, CTX),
      ).rejects.toThrow("disk full");

      // The public metadata audit still settles exactly once.
      expect(toolRow(handle, runId)).toMatchObject({
        actual_outcome: "succeeded",
        reported_outcome: "succeeded",
        result_disposition: "accepted",
      });
      const events = runEvents(handle, runId).map((event) => event.type);
      expect(events.filter((type) => type === "tool.requested")).toHaveLength(
        1,
      );
      expect(events.filter((type) => type === "tool.completed")).toHaveLength(
        1,
      );
      const kinds = recorder.exportRun(runId).map((record) => record.kind);
      expect(kinds).toContain("tool.input");
      expect(kinds).toContain("tool.result");
      expect(kinds).not.toContain("tool.handler.result");
    } finally {
      handle.raw.close();
    }
  });

  it("keeps the eventual public late audit when detached recording fails", async () => {
    const recorder = tempStore();
    const failing = {
      record(input: Parameters<typeof recorder.record>[0]): void {
        if (input.kind === "tool.handler.result") {
          throw new Error("disk full");
        }
        recorder.record(input);
      },
    };
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo);
      const started = deferred();
      const finish = deferred();
      const broker = makeBroker(
        handle,
        repo,
        registration({
          handler: async () => {
            started.resolve();
            await finish.promise;
            return { text: "late-raw-value" };
          },
        }),
        failing,
      );
      const controller = new AbortController();
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "late" },
        {
          ...CTX,
          signal: controller.signal,
        },
      );
      await started.promise;
      controller.abort();
      await pending;

      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      repo.finalizeCancelRequested(runId, { now: T0 + 6 });
      const terminalEvents = runEvents(handle, runId).length;
      finish.resolve();
      await waitFor(
        () => toolRow(handle, runId)?.reported_outcome === "succeeded",
      );
      expect(toolRow(handle, runId)).toMatchObject({
        actual_outcome: "cancelled",
        reported_outcome: "succeeded",
        result_disposition: "discarded",
      });
      expect(runEvents(handle, runId).length).toBe(terminalEvents);
      expect(
        recorder
          .exportRun(runId)
          .some((record) => record.kind === "tool.handler.result"),
      ).toBe(false);
    } finally {
      handle.raw.close();
    }
  });
});
