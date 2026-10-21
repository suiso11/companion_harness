// Private execution-record store invariants: opt-in separation, structural
// credential redaction, explicit storage failures, symlink/path safety,
// bounded records with precise omissions, and operator list/show/export/
// delete/prune semantics. No production data, no network.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionRecordStore,
  createUnavailableExecutionRecorder,
  EXECUTION_RECORD_MAX_BYTES,
  ExecutionRecordError,
  redactRawResponseBody,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "execution-records-"));
  roots.push(root);
  return root;
}

function storeAt(root: string, now = 1_790_000_000_000) {
  return createExecutionRecordStore({
    directory: join(root, "private"),
    clock: { now: () => now },
  });
}

function firstRecord(store: ReturnType<typeof createExecutionRecordStore>) {
  const record = store.list().records[0];
  if (record === undefined) {
    throw new Error("expected one record");
  }
  return record;
}

function onlyRunDir(root: string): string {
  const runs = readdirSync(join(root, "private", "runs"));
  expect(runs).toHaveLength(1);
  return join(root, "private", "runs", runs[0] as string);
}

describe("private execution records", () => {
  it("keeps records private and redacts credential-shaped keys", () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.record({
      kind: "model.request",
      runId: "run-1",
      step: 1,
      callId: "call-1",
      data: {
        model: "local",
        settings: { systemPrompt: "base", fingerprint: "abc" },
        headers: { authorization: "Bearer secret", cookie: "sid=1" },
        nested: [{ apiKey: "never" }, { secret: "never" }],
        message: "keep this text",
      },
    });
    const listing = store.list();
    expect(listing.incomplete).toBe(0);
    expect(listing.records).toHaveLength(1);
    const record = store.inspect(firstRecord(store).id);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("sid=1");
    expect(serialized).not.toContain("never");
    expect(serialized).toContain("[redacted]");
    expect(record.data).toMatchObject({
      model: "local",
      settings: { systemPrompt: "base", fingerprint: "abc" },
      message: "keep this text",
    });
    if (process.platform !== "win32") {
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
      const files = readdirSync(onlyRunDir(root));
      expect(files).toHaveLength(1);
      expect(
        statSync(join(onlyRunDir(root), files[0] as string)).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("preserves malformed raw bodies but redacts JSON credential keys", () => {
    const malformed = '{"choices":[{"message":{"content":"not json"';
    expect(redactRawResponseBody(malformed)).toBe(malformed);
    const body = JSON.stringify({
      headers: { Authorization: "Bearer x", cookie: "a=b" },
      choices: [{ message: { content: "visible answer" } }],
    });
    const redacted = redactRawResponseBody(body);
    expect(redacted).not.toContain("Bearer x");
    expect(redacted).not.toContain("a=b");
    expect(redacted).toContain("visible answer");
  });

  it("redacts raw JSON bodies and encoded JSON arguments structurally, incl. nested JSON", () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.record({
      kind: "tool.input",
      runId: "run-encoded",
      data: {
        arguments: JSON.stringify({ password: "leak-args", keep: 1 }),
        body: JSON.stringify({
          headers: { Authorization: "Bearer leak-body" },
          nested: { arguments: JSON.stringify({ apiKey: "leak-nested" }) },
        }),
        // Unknown keys are model-visible text: never altered (documented
        // freetext limit: leaks here are not structurally detectable).
        content: JSON.stringify({ password: "leak-content" }),
        plain: "keep verbatim",
      },
    });
    const record = store.inspect(firstRecord(store).id);
    const data = record.data as Record<string, unknown>;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("leak-args");
    expect(serialized).not.toContain("leak-body");
    expect(serialized).not.toContain("leak-nested");
    expect(typeof data.arguments).toBe("string");
    expect(JSON.parse(data.arguments as string)).toEqual({
      password: "[redacted]",
      keep: 1,
    });
    const body = JSON.parse(data.body as string) as {
      nested: { arguments: string };
    };
    expect(JSON.parse(body.nested.arguments)).toEqual({ apiKey: "[redacted]" });
    expect(data.content).toBe(JSON.stringify({ password: "leak-content" }));
    expect(data.plain).toBe("keep verbatim");
    // Nested JSON inside a raw response body is also filtered.
    const nestedBody = JSON.stringify({
      inner: { arguments: JSON.stringify({ refreshToken: "leak-raw" }) },
    });
    expect(redactRawResponseBody(nestedBody)).not.toContain("leak-raw");
  });

  it("marks precise omissions instead of rejecting a large valid record", () => {
    const root = tempRoot();
    const store = storeAt(root);
    const huge = "x".repeat(EXECUTION_RECORD_MAX_BYTES + 1024);
    store.record({
      kind: "model.request",
      runId: "run-large",
      step: 1,
      data: {
        messages: [{ role: "user", content: huge }],
        settings: { model: "local", fingerprint: "f" },
      },
    });
    const summary = firstRecord(store);
    expect(summary.omitted).toMatchObject({
      reason: "record_too_large",
      fields: ["messages"],
    });
    const record = store.inspect(summary.id);
    expect(record.omitted?.fields).toEqual(["messages"]);
    expect(record.data).toMatchObject({
      settings: { model: "local", fingerprint: "f" },
    });
    const files = readdirSync(onlyRunDir(root));
    expect(files).toHaveLength(1);
    expect(
      statSync(join(onlyRunDir(root), files[0] as string)).size,
    ).toBeLessThanOrEqual(EXECUTION_RECORD_MAX_BYTES);
  });

  it("captures a legal maximum model request whole, without surprise omissions", () => {
    const root = tempRoot();
    const store = storeAt(root);
    // Legal maximum: 128 messages x 65536 characters (~8.4MB), which the old
    // 2MiB limit could not hold even when no field needed omitting.
    const messages: Array<{ role: string; content: string }> = [];
    for (let index = 0; index < 128; index += 1) {
      messages.push({
        role: index % 2 === 0 ? "user" : "system",
        content: "x".repeat(65536),
      });
    }
    store.record({
      kind: "model.request",
      runId: "run-legal-max",
      step: 1,
      data: { model: "local", messages },
    });
    const summary = firstRecord(store);
    expect(summary.omitted).toBeUndefined();
    const record = store.inspect(summary.id);
    const data = record.data as { model: string; messages: unknown[] };
    expect(data.model).toBe("local");
    expect(data.messages).toHaveLength(128);
    expect(
      String((data.messages[0] as { content: string }).content),
    ).toHaveLength(65536);
    const files = readdirSync(onlyRunDir(root));
    expect(files).toHaveLength(1);
    expect(
      statSync(join(onlyRunDir(root), files[0] as string)).size,
    ).toBeGreaterThan(1_000_000);
  });

  it("fails explicitly on unsafe storage and refuses symlinked roots", () => {
    const root = tempRoot();
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => storeAt(link)).toThrow(ExecutionRecordError);

    const store = storeAt(root);
    // A file where the runs directory must be turns every write into an
    // explicit failure instead of a silent no-op.
    writeFileSync(join(root, "private", "runs"), "not a directory");
    expect(() =>
      store.record({ kind: "tool.input", runId: "run-2", data: {} }),
    ).toThrow(ExecutionRecordError);
    expect(() =>
      createUnavailableExecutionRecorder("disabled").record({
        kind: "tool.input",
        runId: "run-2",
        data: {},
      }),
    ).toThrow(ExecutionRecordError);
  });

  it("reports interrupted writes as incomplete, never as records", () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.record({ kind: "model.response", runId: "run-tmp", data: {} });
    const summary = firstRecord(store);
    writeFileSync(join(onlyRunDir(root), ".tmp-interrupted"), "partial");
    const listing = store.list();
    expect(listing.incomplete).toBe(1);
    expect(listing.records).toHaveLength(1);
    const [first] = listing.records;
    expect(first).toBeDefined();
    expect(first?.runId).toBe("run-tmp");
    expect(first?.id).toBe(summary.id);
  });

  it("prunes exactly the expired K of N records", () => {
    const root = tempRoot();
    let now = 1_790_000_000_000;
    const store = createExecutionRecordStore({
      directory: join(root, "private"),
      clock: { now: () => now },
    });
    const expiredIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      store.record({ kind: "tool.input", runId: "run-prune", data: { index } });
      expiredIds.push(firstRecord(store).id);
      now += 1000;
    }
    now += 40 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < 2; index += 1) {
      store.record({ kind: "tool.input", runId: "run-prune", data: { index } });
      now += 1000;
    }
    expect(store.list().records).toHaveLength(5);

    expect(store.prune(30, now)).toBe(3);
    const remaining = store.list().records;
    expect(remaining).toHaveLength(2);
    for (const id of expiredIds) {
      expect(remaining.some((record) => record.id === id)).toBe(false);
    }
    // Nothing else expires: a second prune is a no-op.
    expect(store.prune(30, now)).toBe(0);
    expect(store.list().records).toHaveLength(2);
  });

  it("supports operator export, delete, and retention pruning", () => {
    const root = tempRoot();
    let now = 1_790_000_000_000;
    const store = createExecutionRecordStore({
      directory: join(root, "private"),
      clock: { now: () => now },
    });
    store.record({ kind: "model.request", runId: "run-a", data: { n: 1 } });
    now += 1000;
    store.record({ kind: "model.response", runId: "run-a", data: { n: 2 } });
    now += 40 * 24 * 60 * 60 * 1000;
    store.record({ kind: "model.request", runId: "run-b", data: { n: 3 } });

    const runA = store.exportRun("run-a");
    expect(runA.map((record) => record.kind)).toEqual([
      "model.request",
      "model.response",
    ]);
    expect(store.exportRun("../../etc/passwd")).toEqual([]);

    const oldest = firstRecord(store);
    expect(store.deleteRecord(oldest.id)).toBe(true);
    expect(store.deleteRecord(oldest.id)).toBe(false);
    expect(store.prune(30, now)).toBe(1); // remaining run-a record
    expect(store.list().records).toHaveLength(1);
    expect(store.deleteRun("run-b")).toBe(1);
    expect(store.list().records).toHaveLength(0);
  });
});
