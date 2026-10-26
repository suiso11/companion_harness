// Unit tests for the native trial staging form mapping (no DOM, no Svelte).
import { describe, expect, test } from "vitest";
import {
  buildTrialStageBody,
  clampTrialCap,
  defaultTrialExpiryLocal,
  localInputToRfc3339,
  splitTrialLines,
  TRIAL_DEFAULT_EXPIRY_MS,
  TRIAL_OPERATIONS,
  toLocalInputValue,
  trialFormErrorText,
  trialOperation,
  trialStageErrorText,
} from "../src/lib/trial_form.js";

const profile = {
  mandatoryChecks: ["lint", "typecheck"],
  ceilings: { timeoutMs: 60000, maxOutputBytes: 1000000 },
};

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    objective: "  implement the thing  ",
    acceptanceText: "it works\n\n  tests pass  \n",
    pathsText: "src/a.ts\nsrc/b.ts\n",
    operation: "implement",
    expiryLocal: "2026-10-26T12:30",
    timeoutValue: "5000",
    maxOutputBytesValue: "10000",
    possibleExternalDataConsent: false,
    ...overrides,
  };
}

describe("trial operation mapping", () => {
  test("derives readOnlyMode from the operation, never from input", () => {
    expect(TRIAL_OPERATIONS.map((o) => [o.value, o.readOnlyMode])).toEqual([
      ["investigate", true],
      ["implement", false],
      ["verify", true],
      ["maintenance_trial", false],
    ]);
    expect(trialOperation("verify")?.readOnlyMode).toBe(true);
    expect(trialOperation("unknown")).toBeNull();
  });
});

describe("expiry conversion", () => {
  test("local datetime-local value becomes the same RFC3339 instant", () => {
    const date = new Date(2026, 9, 26, 12, 30, 0, 0);
    const local = toLocalInputValue(date.getTime());
    expect(local).toBe("2026-10-26T12:30");
    expect(localInputToRfc3339(local)).toBe(date.toISOString());
  });

  test("default expiry is now + 3h in local input form", () => {
    const now = new Date(2026, 9, 26, 9, 0, 0, 0).getTime();
    const local = defaultTrialExpiryLocal(now);
    expect(localInputToRfc3339(local)).toBe(
      new Date(now + TRIAL_DEFAULT_EXPIRY_MS).toISOString(),
    );
    expect(new Date(localInputToRfc3339(local) ?? "").getTime()).toBe(
      now + 3 * 60 * 60 * 1000,
    );
  });

  test("invalid/empty expiry yields null", () => {
    expect(localInputToRfc3339("")).toBeNull();
    expect(localInputToRfc3339("not-a-date")).toBeNull();
  });
});

describe("line splitting and clamping", () => {
  test("splits one entry per non-empty trimmed line", () => {
    expect(splitTrialLines(" a \n\n b\r\nc \n")).toEqual(["a", "b", "c"]);
    expect(splitTrialLines("   ")).toEqual([]);
  });

  test("clamps caps to the operator ceiling and minimum", () => {
    expect(clampTrialCap("999999", 60000, 1000)).toBe(60000);
    expect(clampTrialCap("5000", 60000, 1000)).toBe(5000);
    expect(clampTrialCap("10", 60000, 1000)).toBe(1000);
    expect(clampTrialCap("", 60000, 1000)).toBe(60000);
    expect(clampTrialCap("abc", 60000, 1000)).toBe(60000);
    expect(clampTrialCap("1234.9", 60000, 1000)).toBe(1234);
  });
});

describe("buildTrialStageBody", () => {
  test("maps the form onto the exact strict stage body", () => {
    const result = buildTrialStageBody(inputs(), profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      taskId: "11111111-1111-4111-8111-111111111111",
      objective: "implement the thing",
      acceptance: ["it works", "tests pass"],
      literalPatchPaths: ["src/a.ts", "src/b.ts"],
      operation: "implement",
      readOnlyMode: false,
      expiry: new Date("2026-10-26T12:30").toISOString(),
      possibleExternalDataConsent: false,
      objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
      requiredChecks: ["lint", "typecheck"],
    });
  });

  test("read-only operations derive readOnlyMode=true", () => {
    for (const operation of ["investigate", "verify"]) {
      const result = buildTrialStageBody(inputs({ operation }), profile);
      expect(result.ok && result.body.readOnlyMode).toBe(true);
    }
  });

  test("caps above the ceiling are clamped and consent passes through", () => {
    const result = buildTrialStageBody(
      inputs({
        timeoutValue: "3600000",
        maxOutputBytesValue: "268435456",
        possibleExternalDataConsent: true,
      }),
      profile,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.objectiveResourceCaps).toEqual({
      timeoutMs: 60000,
      maxOutputBytes: 1000000,
    });
    expect(result.body.possibleExternalDataConsent).toBe(true);
  });

  test("requires 1-16 acceptance entries and target paths", () => {
    expect(
      buildTrialStageBody(inputs({ acceptanceText: "" }), profile),
    ).toEqual({ ok: false, error: "acceptance_invalid" });
    expect(
      buildTrialStageBody(
        inputs({ acceptanceText: Array(17).fill("a").join("\n") }),
        profile,
      ),
    ).toEqual({ ok: false, error: "acceptance_invalid" });
    expect(buildTrialStageBody(inputs({ pathsText: " \n " }), profile)).toEqual(
      { ok: false, error: "paths_invalid" },
    );
    expect(
      buildTrialStageBody(
        inputs({ pathsText: Array(17).fill("a").join("\n") }),
        profile,
      ),
    ).toEqual({ ok: false, error: "paths_invalid" });
  });

  test("rejects missing task/objective, unknown operation, bad expiry", () => {
    expect(buildTrialStageBody(inputs({ taskId: "" }), profile)).toEqual({
      ok: false,
      error: "task_required",
    });
    expect(buildTrialStageBody(inputs({ objective: "   " }), profile)).toEqual({
      ok: false,
      error: "objective_required",
    });
    expect(
      buildTrialStageBody(inputs({ operation: "delete" }), profile),
    ).toEqual({ ok: false, error: "operation_invalid" });
    expect(
      buildTrialStageBody(inputs({ expiryLocal: "soon" }), profile),
    ).toEqual({ ok: false, error: "expiry_invalid" });
  });
});

describe("Japanese notices", () => {
  test("form error codes map to fixed notices", () => {
    expect(trialFormErrorText("task_required")).toContain("作業");
    expect(trialFormErrorText("acceptance_invalid")).toContain("1〜16");
    expect(trialFormErrorText("checks_unavailable")).toContain("必須チェック");
  });

  test("server error codes map to fixed notices", () => {
    expect(
      trialStageErrorText(404, { error: { code: "trials_disabled" } }),
    ).toBe("試行の提案は無効です");
    expect(
      trialStageErrorText(400, { error: { code: "validation_error" } }),
    ).toBe("入力内容を確認してください");
    expect(trialStageErrorText(0, null)).toBe("提案の作成に失敗しました");
  });
});
