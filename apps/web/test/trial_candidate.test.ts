import { describe, expect, it } from "vitest";
import {
  candidateChangeNote,
  readTrialCandidate,
  trialCandidateErrorText,
} from "../src/lib/trial_candidate.js";

describe("retained candidate mapping", () => {
  it("maps a valid body and labels file kinds", () => {
    const parsed = readTrialCandidate({
      available: true,
      changes: [
        { path: "apps/a.ts", kind: "modify", size: 12, modeChanged: true },
        { path: "apps/b.ts", kind: "create", size: 3, modeChanged: false },
        { path: "apps/c.ts", kind: "delete", size: 0, modeChanged: false },
      ],
      diff: "--- a/apps/a.ts\n+++ b/apps/a.ts\n",
      truncated: false,
    });
    expect(parsed.available).toBe(true);
    if (!parsed.available) return;
    const [first, second, third] = parsed.view.changes;
    expect(parsed.view.changes).toHaveLength(3);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (!first || !second || !third) return;
    expect(candidateChangeNote(first)).toBe("変更・モード変更");
    expect(candidateChangeNote(second)).toBe("追加");
    expect(candidateChangeNote(third)).toBe("削除");
    expect(parsed.view.diff).not.toContain("<pre");
  });

  it("keeps every supported change instead of dropping past 1,000", () => {
    const changes = Array.from({ length: 1001 }, (_, index) => ({
      path: `apps/${index}.ts`,
      kind: "delete" as const,
      size: 0,
      modeChanged: false,
    }));
    const parsed = readTrialCandidate({
      available: true,
      changes,
      diff: "",
      truncated: false,
    });
    expect(parsed.available).toBe(true);
    if (!parsed.available) return;
    expect(parsed.view.changes).toHaveLength(1001);
  });

  it("maps fixed error codes to Japanese messages", () => {
    expect(trialCandidateErrorText("candidate_unavailable")).toContain(
      "保持されていません",
    );
    expect(trialCandidateErrorText("candidate_digest_mismatch")).toContain(
      "検証",
    );
    expect(trialCandidateErrorText("base_mismatch")).toContain("照合");
  });

  it("degrades malformed bodies to candidate_unavailable", () => {
    expect(readTrialCandidate({ available: true, changes: "x" })).toEqual({
      available: false,
      code: "candidate_unavailable",
    });
    expect(readTrialCandidate(null)).toEqual({
      available: false,
      code: "candidate_unavailable",
    });
  });
});
