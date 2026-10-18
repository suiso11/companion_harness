// M6 contract coupling regression (host PR38 review:
// "Couple proposal inputs to their tool discriminant").
//
// `tool` and `input` must never validate as independent unions: a
// `calendar.create` row carrying a reschedule-only `{ start, end }`
// input (or vice versa) is an impossible combination and must REJECT at
// both `ActionProposalSchema` and `ProposalSummarySchema` with the issue
// reported on the `input` path — fail closed before pending/approval.
// Valid per-tool combinations on both schemas still ACCEPT (consumer
// behavior, not source copies): reschedule rows keep their full
// existing-event target (NON-NULL) and create rows keep it NULL.

import { describe, expect, it } from "vitest";
import {
  ActionProposalSchema,
  CALENDAR_CREATE_TOOL_NAME,
  CALENDAR_RESCHEDULE_TOOL_NAME,
  PROPOSAL_TTL_MS,
  ProposalSummarySchema,
} from "../src/index.js";

const uuid = (seed: string): string => {
  const hex = seed.padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const HASH = "a".repeat(64);
const SUMMARY = { summary: "deterministic preview" };
const NOW = 1_700_000_000_000;

function rescheduleProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid("11"),
    sessionId: uuid("22"),
    sourceTurnId: uuid("33"),
    sourceRunId: uuid("44"),
    decisionTurnId: null,
    tool: CALENDAR_RESCHEDULE_TOOL_NAME,
    connectorInstanceId: uuid("55"),
    input: { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z" },
    targetRefId: uuid("66"),
    targetResourceId: uuid("77"),
    basedOnSnapshotId: uuid("88"),
    expectedRevision: "rev-1",
    preview: SUMMARY,
    hash: HASH,
    status: "pending",
    createdAt: NOW,
    expiresAt: NOW + PROPOSAL_TTL_MS,
    ...overrides,
  };
}

function createProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid("aa"),
    sessionId: uuid("bb"),
    sourceTurnId: uuid("cc"),
    sourceRunId: uuid("dd"),
    decisionTurnId: null,
    tool: CALENDAR_CREATE_TOOL_NAME,
    connectorInstanceId: uuid("ee"),
    input: {
      title: "Kickoff",
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
    },
    targetRefId: null,
    targetResourceId: null,
    basedOnSnapshotId: null,
    expectedRevision: null,
    preview: SUMMARY,
    hash: HASH,
    status: "pending",
    createdAt: NOW,
    expiresAt: NOW + PROPOSAL_TTL_MS,
    ...overrides,
  };
}

function summaryOf(proposal: Record<string, unknown>) {
  return {
    proposalId: proposal.id,
    tool: proposal.tool,
    input: proposal.input,
    preview: proposal.preview,
    hash: proposal.hash,
    status: proposal.status,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    resolvedAt: null,
    decisionTurnId: null,
  };
}

describe("action tool/input coupling", () => {
  it("accepts both valid per-tool proposal shapes (target coupling preserved)", () => {
    expect(ActionProposalSchema.safeParse(rescheduleProposal()).success).toBe(
      true,
    );
    expect(ActionProposalSchema.safeParse(createProposal()).success).toBe(true);
  });

  it("rejects both wrong-tool input combinations on the proposal schema (input path)", () => {
    const createWithRescheduleInput = createProposal({
      input: { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z" },
    });
    const rescheduleWithCreateInput = rescheduleProposal({
      input: {
        title: "Kickoff",
        start: "2026-03-01T10:00:00Z",
        end: "2026-03-01T11:00:00Z",
      },
    });
    for (const doc of [createWithRescheduleInput, rescheduleWithCreateInput]) {
      const parsed = ActionProposalSchema.safeParse(doc);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.path.join(".").startsWith("input"),
          ),
        ).toBe(true);
      }
    }
  });

  it("accepts both valid per-tool summary shapes", () => {
    expect(
      ProposalSummarySchema.safeParse(summaryOf(rescheduleProposal())).success,
    ).toBe(true);
    expect(
      ProposalSummarySchema.safeParse(summaryOf(createProposal())).success,
    ).toBe(true);
  });

  it("rejects both wrong-tool input combinations on the summary schema (input path)", () => {
    const badSummaries = [
      summaryOf(
        createProposal({
          input: { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z" },
        }),
      ),
      summaryOf(
        rescheduleProposal({
          input: {
            title: "Kickoff",
            start: "2026-03-01T10:00:00Z",
            end: "2026-03-01T11:00:00Z",
          },
        }),
      ),
    ];
    for (const doc of badSummaries) {
      const parsed = ProposalSummarySchema.safeParse(doc);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.path.join(".").startsWith("input"),
          ),
        ).toBe(true);
      }
    }
  });
});
