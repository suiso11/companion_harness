// AGORA tool handlers must never convert an execution-record failure into an
// ordinary tool result: the broker relies on ExecutionRecordError escaping to
// abort the run (fail closed), even when the AGORA action itself succeeded.
import { describe, expect, it } from "vitest";
import type { AgoraProposalRow, AgoraService } from "../src/agora.js";
import { createAgoraToolRegistrations } from "../src/agora_tools.js";
import type { ToolRegistration } from "../src/broker.js";
import { ExecutionRecordError } from "../src/execution_records.js";
import type { KernelRepository } from "../src/repository.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const row: AgoraProposalRow = {
  id: "33333333-3333-4333-8333-333333333333",
  operation: "thread",
  payload: { title: "Title", body: "Body" },
  payloadHash: "a".repeat(64),
  status: "pending",
  sessionId: SESSION,
  createdAt: 1,
  expiresAt: 2,
  decidedAt: null,
  consumedAt: null,
  httpStatus: null,
  resultCode: null,
  resultThreadId: null,
  resultUrl: null,
  approvalSource: null,
};

const failingRecorder = {
  record(): void {
    throw new ExecutionRecordError("record_write_failed", "disk full");
  },
};

const fakeStore = {
  propose: () => row,
  send: async () => ({ kind: "sent", proposal: row, retryAfterMs: null }),
} as unknown as AgoraService;

const fakeRepo = {
  getRun: () => ({ sessionId: SESSION }),
} as unknown as KernelRepository;

type DirectInvoke = (input: unknown, ctx: unknown) => Promise<unknown>;

function registration(name: string): ToolRegistration {
  const found = createAgoraToolRegistrations({
    store: fakeStore,
    repo: fakeRepo,
    recorder: failingRecorder,
  }).find((candidate) => candidate.descriptor.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}

const ctx = {
  runId: RUN,
  signal: new AbortController().signal,
  origin: "test-origin",
  caller: "test-caller",
};

describe("agora tools execution records", () => {
  it("propagates ExecutionRecordError from proposal and send handlers", async () => {
    const propose = registration("agora.propose_thread");
    await expect(
      (propose.handler as unknown as DirectInvoke)(
        { title: "Title", body: "Body" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ExecutionRecordError);

    const send = registration("agora.send");
    await expect(
      (send.handler as unknown as DirectInvoke)(
        { proposalId: row.id, payloadHash: row.payloadHash },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ExecutionRecordError);
  });
});
