// Codex review regressions on PR #42 (batch 3/3): shadow prompt fidelity.
//
// Proves `buildShadowUserPrompt` renders through the REAL prompt builder:
// - a linked task cites its frozen owner as the `sP` label (never
//   `parent:label-withheld`), so deliberation sees the real
//   task->purpose relation;
// - the UNTRUSTED explicit-request text appears as citable `sQ1` input
//   (different reasons give different prompts), and reason-less contexts
//   honestly report that no `sQ1` label exists;
// - frozen task `body` + `reconsiderTrigger` reach the model input.

import { randomUUID } from "node:crypto";
import type { ShadowJobContext } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { buildShadowUserPrompt } from "../src/shadow_service.js";

const T0 = 1_700_004_000_000;

function baseContext(extra: Record<string, unknown> = {}): ShadowJobContext {
  return {
    sessionId: randomUUID(),
    scope: "health",
    purposes: [],
    tasks: [],
    conflictPairs: [],
    activeConstraintIds: [],
    permissionClaims: [],
    explicitDeadlines: [],
    priorFailures: [],
    memories: [],
    requestReason: null,
    claimControlVersion: 2,
    claimScopeEpoch: 1,
    capturedAt: T0,
    ...extra,
  } as unknown as ShadowJobContext;
}

describe("codex #42 batch 3 prompt fidelity", () => {
  it("renders task parents as sP labels (never label-withheld)", () => {
    const purposeId = randomUUID();
    const context = baseContext({
      purposes: [
        {
          label: "sP1",
          id: purposeId,
          version: 1,
          status: "active",
          kind: "goal",
          explicitness: "explicit",
          source: "user",
          scope: "health",
          statement: "walk daily",
          interpretation: null,
          validFrom: null,
          validUntil: null,
          supersededBy: null,
          applicableAtClaim: true,
        },
      ],
      tasks: [
        {
          label: "sT1",
          id: randomUUID(),
          version: 1,
          status: "open",
          kind: "task",
          speaker: "user",
          title: "buy shoes",
          body: null,
          deadline: null,
          parentPurposeId: purposeId,
          reconsiderTrigger: null,
        },
      ],
    });
    const prompt = buildShadowUserPrompt({
      context,
      triggerEvent: "task.created",
      kind: "policy_change",
      memoryConfigured: false,
    });
    expect(prompt).toContain("parent:sP1");
    expect(prompt).not.toContain("parent:label-withheld");
  });

  it("renders the untrusted request text as sQ1 (different reasons differ)", () => {
    const first = buildShadowUserPrompt({
      context: baseContext({ requestReason: "focus on morning walks" }),
      triggerEvent: "explicit.request",
      kind: "explicit_request",
      memoryConfigured: false,
    });
    expect(first).toContain("sQ1");
    expect(first).toContain("focus on morning walks");
    const second = buildShadowUserPrompt({
      context: baseContext({ requestReason: "focus on evening meals" }),
      triggerEvent: "explicit.request",
      kind: "explicit_request",
      memoryConfigured: false,
    });
    expect(second).toContain("focus on evening meals");
    expect(second).not.toBe(first);
    const bare = buildShadowUserPrompt({
      context: baseContext(),
      triggerEvent: "purpose.created",
      kind: "policy_change",
      memoryConfigured: false,
    });
    expect(bare).toContain("no sQ1 label exists");
    expect(bare).not.toContain("cite as sQ1 when relevant");
  });

  it("renders frozen task body + reconsiderTrigger", () => {
    const context = baseContext({
      tasks: [
        {
          label: "sT1",
          id: randomUUID(),
          version: 2,
          status: "held",
          kind: "task",
          speaker: "user",
          title: "take pills",
          body: "take pills after breakfast",
          deadline: null,
          parentPurposeId: null,
          reconsiderTrigger: "doctor replies",
        },
      ],
    });
    const prompt = buildShadowUserPrompt({
      context,
      triggerEvent: "explicit.request",
      kind: "explicit_request",
      memoryConfigured: false,
    });
    expect(prompt).toContain("take pills after breakfast");
    expect(prompt).toContain("reconsider:doctor replies");
  });
});
