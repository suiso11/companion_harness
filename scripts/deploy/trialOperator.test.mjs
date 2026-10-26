// Pure tests for the frozen trial-operator builder helpers, plus a static
// ordering test for the deploy integration (build after install, before
// restart, and never fatal to the app deploy).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatAutonomyEnvLine,
  selectFrozenRootsToPrune,
  validateTrialOperatorInput,
} from "./trialOperator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const runtimeKeys = [
  "nodeRealpath",
  "ompRealpath",
  "bwrapRealpath",
  "systemdRunRealpath",
  "systemctlRealpath",
  "piOrchLauncherRealpath",
  "piOrchShellRealpath",
  "piOrchConfigRealpath",
  "piOrchExtensionRealpath",
  "piOrchLockRealpath",
];
const baseInput = {
  workspaceAlias: "companion-harness",
  sourceRepo: "/home/u/companion_master",
  sourceRef: "origin/master",
  stateRoot: "/home/u/.local/share/companion-harness/autonomy",
  operatorFile: "/home/u/.local/share/companion-harness/autonomy/operator.json",
  environmentFile: "/home/u/.config/companion/autonomy.env",
  mandatoryChecks: ["lint", "typecheck"],
  limits: {
    timeoutMs: 900000,
    maxOutputBytes: 262144,
    maxModelCalls: 64,
    maxOutputTokens: 4096,
    maxModelCallMs: 60000,
    maxConcurrent: 1,
    jobsPerDay: 3,
  },
  runner: {
    relay: {
      maxRequestBytes: 1048576,
      maxModelCalls: 64,
      maxOutputTokens: 4096,
      maxResponseBytes: 1048576,
      perCallTimeoutMs: 60000,
      maxConcurrent: 1,
    },
    observe: { activeTimeoutMs: 5000, goneTimeoutMs: 5000, pollIntervalMs: 50 },
    pollMs: 500,
  },
  runtime: Object.fromEntries(
    runtimeKeys.map((key) => [key, `/usr/bin/${key}`]),
  ),
};

const clone = () => JSON.parse(JSON.stringify(baseInput));

describe("validateTrialOperatorInput", () => {
  it("normalizes the documented host input", () => {
    const input = validateTrialOperatorInput(baseInput);
    expect(input.workspaceAlias).toBe("companion-harness");
    expect(input.mandatoryChecks).toEqual(["lint", "typecheck"]);
    expect(input.runtime.nodeRealpath).toBe("/usr/bin/nodeRealpath");
  });

  it("rejects unknown keys and unsafe aliases", () => {
    const extra = clone();
    extra.surprise = true;
    expect(() => validateTrialOperatorInput(extra)).toThrow(/unknown key/);
    const badAlias = clone();
    badAlias.workspaceAlias = "Has Space";
    expect(() => validateTrialOperatorInput(badAlias)).toThrow(
      /workspaceAlias/,
    );
  });

  it("rejects empty/duplicate checks and out-of-range caps", () => {
    const empty = clone();
    empty.mandatoryChecks = [];
    expect(() => validateTrialOperatorInput(empty)).toThrow(/mandatoryChecks/);
    const dup = clone();
    dup.mandatoryChecks = ["lint", "lint"];
    expect(() => validateTrialOperatorInput(dup)).toThrow(/duplicate/);
    const tooMany = clone();
    tooMany.limits.maxModelCalls = 65;
    expect(() => validateTrialOperatorInput(tooMany)).toThrow(/maxModelCalls/);
    const tooConcurrent = clone();
    tooConcurrent.runner.relay.maxConcurrent = 2;
    expect(() => validateTrialOperatorInput(tooConcurrent)).toThrow(
      /maxConcurrent/,
    );
  });

  it("requires every runtime path to be absolute", () => {
    const input = clone();
    input.runtime.ompRealpath = "omp";
    expect(() => validateTrialOperatorInput(input)).toThrow(
      /runtime.ompRealpath/,
    );
  });
});

describe("formatAutonomyEnvLine", () => {
  it("emits one shell-quoted line that systemd can unquote to the JSON", () => {
    const json = JSON.stringify({
      enabled: true,
      workspaceAlias: "companion-harness",
    });
    const line = formatAutonomyEnvLine(json);
    expect(line).toBe(`COMPANION_AUTONOMY_JSON='${json}'\n`);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    const value = line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
    expect(JSON.parse(value)).toEqual(JSON.parse(json));
  });

  it("rejects quotes, newlines and invalid JSON", () => {
    expect(() => formatAutonomyEnvLine('{"x":"\'"}')).toThrow(/quotes/);
    expect(() => formatAutonomyEnvLine('{"x":\n1}')).toThrow(/newlines/);
    expect(() => formatAutonomyEnvLine("not json")).toThrow();
  });
});

describe("selectFrozenRootsToPrune", () => {
  it("keeps the current root plus the newest other root", () => {
    const names = [
      "frozen-aaaaaaa-20260101T000000Z",
      "frozen-bbbbbbb-20260102T000000Z",
      "frozen-ccccccc-20260103T000000Z",
      "src-aaaaaaa",
    ];
    expect(
      selectFrozenRootsToPrune(names, "frozen-ccccccc-20260103T000000Z", 2),
    ).toEqual(["frozen-aaaaaaa-20260101T000000Z"]);
  });

  it("never prunes non-frozen entries", () => {
    expect(
      selectFrozenRootsToPrune(["dep-source-clean", "src-x"], "frozen-a", 2),
    ).toEqual([]);
  });
});

describe("companion-deploy.sh trial-operator ordering", () => {
  const source = readFileSync(join(HERE, "companion-deploy.sh"), "utf8");
  const installAt = source.indexOf(
    "pnpm install --frozen-lockfile\n\n# --- frozen trial operator",
  );
  const buildAt = source.indexOf("build-trial-operator.mts");
  const restartAt = source.indexOf(
    "systemctl --user restart companion.service",
    buildAt,
  );

  it("builds after install and before the restart", () => {
    expect(installAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(installAt);
    expect(restartAt).toBeGreaterThan(buildAt);
  });

  it("does not block the deploy when the trial rebuild fails", () => {
    const block = source.slice(installAt, restartAt);
    expect(block).toMatch(/if ! .*build-trial-operator\.mts/);
    expect(block).toMatch(/autonomy\.env left unchanged/);
    expect(block).not.toMatch(/build-trial-operator\.mts[\s\S]*?\bexit 1\b/);
  });
});
