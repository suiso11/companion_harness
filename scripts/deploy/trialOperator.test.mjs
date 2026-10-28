// Pure tests for the frozen trial-operator builder helpers, plus a static
// ordering test for the deploy integration (build after install, before
// restart, and never fatal to the app deploy).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseAutodispatchConfig,
  parseTrialConfig,
} from "../../apps/server/src/config.ts";
import { disableTrialEnv } from "./disable-trial-env.mjs";
import {
  assertHostAutodispatchChecks,
  formatAutonomyEnvLine,
  frozenRootReferencedByOperator,
  resolveCurrentModel,
  SEALED_SOURCE_ROOTS,
  SEALED_TOP_LEVEL_FILES,
  sealedLintArgs,
  sealedLintTargets,
  selectCheckCommands,
  selectFrozenRootsToPrune,
  selectSealedChecks,
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

describe("disableTrialEnv", () => {
  const json = JSON.stringify({
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    workspaceAlias: "companion-harness",
    currentModel: "local-chat",
  });
  const env = {
    COMPANION_MODEL_JSON: JSON.stringify({ model: "local-chat" }),
  };
  const parse = (line) =>
    JSON.parse(line.slice(line.indexOf("'") + 1, line.lastIndexOf("'")));

  it("keeps the previous config valid but disabled", () => {
    const line = disableTrialEnv(`COMPANION_AUTONOMY_JSON='${json}'\n`, {
      env,
    });
    expect(line).toBe(
      `COMPANION_AUTONOMY_JSON='${JSON.stringify({ ...JSON.parse(json), enabled: false })}'\n`,
    );
    expect(parse(line)).toMatchObject({
      enabled: false,
      mandatoryChecks: ["lint"],
      currentModel: "local-chat",
    });
  });

  it("rebinds the disabled fallback to the effective host model", () => {
    const line = disableTrialEnv(`COMPANION_AUTONOMY_JSON='${json}'\n`, {
      env: { COMPANION_MODEL_JSON: JSON.stringify({ model: "new-model" }) },
    });
    expect(parse(line)).toMatchObject({
      enabled: false,
      currentModel: "new-model",
    });
  });

  it("rebinds through the .env.litellm alias like the builder", () => {
    const line = disableTrialEnv(`COMPANION_AUTONOMY_JSON='${json}'\n`, {
      env: {},
      litellmEnvText: "LITELLM_MASTER_KEY=abc\n",
    });
    expect(parse(line)).toMatchObject({
      enabled: false,
      currentModel: "local-chat",
    });
  });

  it("returns nothing when the effective model cannot be resolved", () => {
    expect(
      disableTrialEnv(`COMPANION_AUTONOMY_JSON='${json}'\n`, { env: {} }),
    ).toBe("");
  });

  it("old-format fallback reaches the new strict parser but starts disabled (#167)", () => {
    const line = disableTrialEnv(`COMPANION_AUTONOMY_JSON='${json}'\n`, {
      env,
    });
    // The old shape lacks the now-required scope fields...
    expect(() => parseTrialConfig(JSON.stringify(parse(line)))).toThrow(
      /trial config/,
    );
    // ...so the server's legacy guard fails closed (see config.test.ts).
    // A NEW-format config disabled by the same helper parses strictly.
    const newFormat = {
      available: true,
      enabled: true,
      mandatoryChecks: ["lint"],
      configFingerprint: "0".repeat(64),
      sourceRevision: "0".repeat(40),
      sourceRepoPath: "/opt/source-snapshot",
      currentModel: "local-chat",
      disclosedWholeRepoRead: true,
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
      workspaceAlias: "companion-harness",
      allowedPaths: ["apps"],
      modelRoute: "local",
      runner: {
        nodeRealpath: "/usr/bin/node",
        bridgeScriptPath: "/opt/bridge.mjs",
        bridgeConfigTemplatePath: "/opt/bridge.template.json",
        systemctlRealpath: "/usr/bin/systemctl",
        xdgRuntimeDir: "/run/user/1000",
        relay: {
          maxRequestBytes: 1_048_576,
          maxModelCalls: 8,
          maxOutputTokens: 256,
          maxResponseBytes: 1_048_576,
          perCallTimeoutMs: 60_000,
          maxConcurrent: 1,
        },
        observe: {
          activeTimeoutMs: 5000,
          goneTimeoutMs: 5000,
          pollIntervalMs: 50,
        },
        pollMs: 500,
      },
    };
    const newLine = disableTrialEnv(
      `COMPANION_AUTONOMY_JSON='${JSON.stringify(newFormat)}'\n`,
      { env },
    );
    expect(parseTrialConfig(JSON.stringify(parse(newLine)))).toMatchObject({
      enabled: false,
    });
  });

  it("returns nothing when no usable line exists", () => {
    expect(disableTrialEnv("")).toBe("");
    expect(disableTrialEnv("OTHER=1\n")).toBe("");
    expect(disableTrialEnv("COMPANION_AUTONOMY_JSON='not json'\n")).toBe("");
    expect(disableTrialEnv("COMPANION_AUTONOMY_JSON='[]'\n")).toBe("");
  });
});

describe("parseTrialConfig blank value", () => {
  it("rejects an empty string, so a blank env line cannot disable trials", () => {
    expect(() => parseTrialConfig("")).toThrow(/JSON object/);
  });
});

describe("sealedLintArgs", () => {
  it("names only source paths and never the guest observation scratch", () => {
    const args = sealedLintArgs("/deps/biome", [
      ...SEALED_SOURCE_ROOTS,
      ...SEALED_TOP_LEVEL_FILES,
      ".companion-observation",
      ".companion-observation/guest.json",
    ]);
    expect(args).not.toContain("/work");
    expect(args.some((arg) => arg.includes(".companion-observation"))).toBe(
      false,
    );
    expect(args).toContain("/work/apps");
    expect(args).toContain("/work/packages");
    expect(args).toContain("/work/package.json");
    expect(args).toContain("--files-ignore-unknown=true");
  });

  it("defaults to the sealed source roots and preserved top-level files", () => {
    expect(sealedLintTargets()).toEqual([
      ...SEALED_SOURCE_ROOTS.map((entry) => `/work/${entry}`),
      ...SEALED_TOP_LEVEL_FILES.map((entry) => `/work/${entry}`),
    ]);
  });
});

describe("selectFrozenRootsToPrune", () => {
  const names = [
    "frozen-aaaaaaa-20260101T000000Z",
    "frozen-bbbbbbb-20260102T000000Z",
    "frozen-ccccccc-20260103T000000Z",
    "src-aaaaaaa",
  ];

  it("protects the current root and keeps the newest two unreferenced roots", () => {
    expect(
      selectFrozenRootsToPrune(names, "frozen-ccccccc-20260103T000000Z", 2),
    ).toEqual([]);
  });

  it("never prunes a root referenced by the operator or rollback backup", () => {
    // The oldest root is still active on the previous revision.
    expect(
      selectFrozenRootsToPrune(names, "frozen-ccccccc-20260103T000000Z", 2, [
        "frozen-aaaaaaa-20260101T000000Z",
      ]),
    ).toEqual([]);
  });

  it("prunes only unreferenced roots older than the newest two", () => {
    const many = [
      "frozen-aaaaaaa-20260101T000000Z",
      "frozen-bbbbbbb-20260102T000000Z",
      "frozen-ccccccc-20260103T000000Z",
      "frozen-ddddddd-20260104T000000Z",
      "frozen-eeeeeee-20260105T000000Z",
    ];
    expect(
      selectFrozenRootsToPrune(many, "frozen-eeeeeee-20260105T000000Z", 2, [
        "frozen-aaaaaaa-20260101T000000Z",
      ]),
    ).toEqual(["frozen-bbbbbbb-20260102T000000Z"]);
  });

  it("orders by timestamp suffix, not by commit sha in the name", () => {
    expect(
      selectFrozenRootsToPrune(
        [
          "frozen-fffffff-20260101T000000Z",
          "frozen-aaaaaaa-20260102T000000Z",
          "frozen-bbbbbbb-20260103T000000Z",
        ],
        "frozen-bbbbbbb-20260103T000000Z",
        2,
      ),
    ).toEqual([]);
  });

  it("never prunes non-frozen entries", () => {
    expect(
      selectFrozenRootsToPrune(["dep-source-clean", "src-x"], "frozen-a", 2),
    ).toEqual([]);
  });
});

describe("frozenRootReferencedByOperator", () => {
  const stateRoot = "/home/u/.local/share/companion-harness/autonomy";
  const operatorText = JSON.stringify({
    sealed: {
      rootDir: `${stateRoot}/frozen-abcdef0-20260101T000000Z/state/jobs/x`,
    },
  });

  it("returns the frozen root referenced by operator.json", () => {
    expect(frozenRootReferencedByOperator(operatorText, stateRoot)).toBe(
      "frozen-abcdef0-20260101T000000Z",
    );
  });

  it("ignores roots outside the state root and non-frozen paths", () => {
    expect(
      frozenRootReferencedByOperator(
        JSON.stringify({
          sealed: { rootDir: "/other/frozen-abcdef0-20260101T000000Z" },
        }),
        stateRoot,
      ),
    ).toBeNull();
    expect(
      frozenRootReferencedByOperator(
        JSON.stringify({
          sealed: { rootDir: `${stateRoot}/dep-source-clean` },
        }),
        stateRoot,
      ),
    ).toBeNull();
  });

  it("fails closed on unreadable operator JSON", () => {
    expect(() => frozenRootReferencedByOperator("{", stateRoot)).toThrow(
      /refusing to prune/,
    );
  });
});

describe("resolveCurrentModel", () => {
  it("uses the model from an exported COMPANION_MODEL_JSON", () => {
    expect(
      resolveCurrentModel({
        COMPANION_MODEL_JSON: JSON.stringify({
          adapter: "openai-compatible",
          baseUrl: "http://127.0.0.1:4000",
          model: "host-model",
          apiKey: "secret",
        }),
      }),
    ).toBe("host-model");
  });

  it("falls back to local-chat from a non-empty .env.litellm key", () => {
    expect(resolveCurrentModel({}, "LITELLM_MASTER_KEY=abc\n")).toBe(
      "local-chat",
    );
    expect(() => resolveCurrentModel({}, "LITELLM_MASTER_KEY=\n")).toThrow(
      /cannot determine/,
    );
  });

  it("fails the build when no model can be determined", () => {
    expect(() => resolveCurrentModel({})).toThrow(/cannot determine/);
    expect(() =>
      resolveCurrentModel({ COMPANION_MODEL_JSON: JSON.stringify({}) }),
    ).toThrow(/model is required/);
    expect(() => resolveCurrentModel({ COMPANION_MODEL_JSON: "{" })).toThrow(
      /not valid JSON/,
    );
  });
});

describe("selectSealedChecks", () => {
  it("drops checks the sealed workspace cannot run", () => {
    expect(selectSealedChecks(["lint", "typecheck"], ["lint"])).toEqual([
      "lint",
    ]);
  });

  it("fails when nothing runnable remains", () => {
    expect(() => selectSealedChecks(["typecheck"], ["lint"])).toThrow(
      /no supported mandatoryChecks/,
    );
  });
});

describe("autodispatch config shape (real parser)", () => {
  const relay = {
    maxRequestBytes: 1_048_576,
    maxModelCalls: 64,
    maxOutputTokens: 4096,
    maxResponseBytes: 1_048_576,
    perCallTimeoutMs: 60_000,
    maxConcurrent: 1,
  };
  const observe = {
    activeTimeoutMs: 5000,
    goneTimeoutMs: 5000,
    pollIntervalMs: 50,
  };
  const bridge =
    "/srv/companion_master/scripts/pi-orch-bridge/companion-bridge.mjs";
  const trial = parseTrialConfig(
    JSON.stringify({
      available: true,
      enabled: true,
      mandatoryChecks: ["lint"],
      configFingerprint: "0".repeat(64),
      sourceRevision: "0".repeat(40),
      sourceRepoPath: "/synthetic/source",
      currentModel: resolveCurrentModel({
        COMPANION_MODEL_JSON: JSON.stringify({ model: "local-chat" }),
      }),
      disclosedWholeRepoRead: true,
      timeoutMs: 900_000,
      maxOutputBytes: 262_144,
      workspaceAlias: "companion-harness",
      allowedPaths: ["apps", "packages"],
      modelRoute: "local",
      runner: {
        nodeRealpath: "/usr/bin/node",
        bridgeScriptPath: bridge,
        bridgeConfigTemplatePath:
          "/home/u/.config/companion/trial-operator.json",
        systemctlRealpath: "/usr/bin/systemctl",
        xdgRuntimeDir: "/run/user/1000",
        relay,
        observe,
        pollMs: 500,
      },
    }),
  );
  const selectedChecks = selectSealedChecks(["lint", "typecheck"], ["lint"]);
  const adRaw = {
    enabled: true,
    workspaceAlias: "companion-harness",
    sourceRoot: "/synthetic/source",
    operations: ["investigate", "implement"],
    readScopes: ["apps", "packages", "scripts", "docs"],
    writeScopes: ["apps", "packages"],
    checks: selectedChecks,
    caps: {
      timeoutMs: 900_000,
      maxOutputBytes: 262_144,
      maxModelCalls: 64,
      maxOutputTokens: 4096,
      perCallTimeoutMs: 60_000,
      maxRequestBytes: relay.maxRequestBytes,
      maxResponseBytes: relay.maxResponseBytes,
      maxConcurrent: 1,
      jobsPerDay: 3,
      concurrentExecutions: 1,
    },
    dependencyRoot: null,
    bridgeScriptPath: bridge,
    bridgeConfigTemplatePath: "/home/u/.config/companion/trial-operator.json",
    materialization: {
      stateDir: "/synthetic/state",
      executor: {
        kind: "real-pi",
        executable:
          "/synthetic/source/scripts/pi-orch-bridge/pi-orch-guest.mjs",
        args: [],
      },
      checks: {
        lint: {
          executable: "/usr/bin/node",
          args: [
            "/deps/node_modules/@biomejs/biome/bin/biome",
            "check",
            "/work",
          ],
        },
      },
      executionBackend: "confined",
      runtime: { nodeRealpath: "/usr/bin/node" },
      dependencySourceNodeModules: "/synthetic/dep-source-clean/node_modules",
      allowedTopLevelFiles: ["package.json"],
      maxDurationMs: 900_000,
      modelRoute: "local",
    },
  };

  it("accepts checks as a name array plus the materialization command map", () => {
    const parsed = parseAutodispatchConfig(JSON.stringify(adRaw), trial);
    expect(parsed).not.toBeNull();
    expect(parsed?.checks).toEqual(["lint"]);
    expect(Object.keys(parsed?.materialization?.checks ?? {})).toEqual([
      "lint",
    ]);
  });

  it("rejects the filtered command map in the top-level checks field", () => {
    expect(() =>
      parseAutodispatchConfig(
        JSON.stringify({ ...adRaw, checks: adRaw.materialization.checks }),
        trial,
      ),
    ).toThrow(/autodispatch checks are invalid/);
  });
});

describe("assertHostAutodispatchChecks", () => {
  it("accepts an absent or matching host check set", () => {
    expect(() =>
      assertHostAutodispatchChecks(undefined, ["lint"]),
    ).not.toThrow();
    expect(() =>
      assertHostAutodispatchChecks(JSON.stringify({ checks: ["lint"] }), [
        "lint",
      ]),
    ).not.toThrow();
  });

  it("rejects a host check set the sealed trial cannot match", () => {
    expect(() =>
      assertHostAutodispatchChecks(
        JSON.stringify({ checks: ["lint", "typecheck"] }),
        ["lint"],
      ),
    ).toThrow(/do not match the sealed trial checks/);
  });

  it("rejects malformed host config", () => {
    expect(() => assertHostAutodispatchChecks("not-json", ["lint"])).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      assertHostAutodispatchChecks(JSON.stringify({ checks: "lint" }), [
        "lint",
      ]),
    ).toThrow(/checks must be an array/);
  });
});

describe("selectCheckCommands", () => {
  const available = {
    lint: {
      executable: "/usr/bin/node",
      args: ["/deps/biome", "check", "/work"],
    },
    typecheck: { executable: "/usr/bin/node", args: ["/deps/tsc"] },
  };

  it("returns only the selected checks", () => {
    expect(Object.keys(selectCheckCommands(available, ["lint"]))).toEqual([
      "lint",
    ]);
    expect(Object.keys(selectCheckCommands(available, ["typecheck"]))).toEqual([
      "typecheck",
    ]);
  });

  it("rejects an unknown check", () => {
    expect(() => selectCheckCommands(available, ["deploy"])).toThrow(
      /unsupported mandatoryChecks/,
    );
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

  it("restores the previous trial profile before a rollback restart", () => {
    const rollbackAt = source.indexOf("\nrollback() {") + 1;
    const rollbackEnd = source.indexOf("\n}\n", rollbackAt);
    const body = source.slice(rollbackAt, rollbackEnd);
    expect(body).toContain("$TRIAL_BACKUP_DIR/operator.json");
    expect(body).toContain("$TRIAL_BACKUP_DIR/autonomy.env");
    expect(body.indexOf("TRIAL_BACKUP_DIR/operator.json")).toBeLessThan(
      body.indexOf("systemctl --user restart"),
    );
  });

  it("backs up the profile before the build and clears it on success", () => {
    const backupAt = source.indexOf("companion-trial-backup");
    expect(backupAt).toBeGreaterThan(-1);
    expect(backupAt).toBeLessThan(source.indexOf("build-trial-operator.mts"));
    expect(source).toMatch(/notify_success[\s\S]*?rm -rf "\$TRIAL_BACKUP_DIR"/);
  });

  it("fails closed by atomically disabling autonomy.env when the rebuild fails", () => {
    const block = source.slice(installAt, restartAt);
    expect(block).toContain("BUILD_OK=0");
    expect(block).toMatch(/rebuild FAILED[\s\S]*?fail closed/);
    expect(block).toContain("disable-trial-env.mjs");
    expect(block).toContain('TRIAL_ENV_TMP="${TRIAL_ENV_FILE}.tmp-$$"');
    expect(block).toMatch(
      /printf '%s\\n' "\$DISABLED_ENV_LINE" > "\$TRIAL_ENV_TMP"/,
    );
    expect(block).toMatch(/mv -f "\$TRIAL_ENV_TMP" "\$TRIAL_ENV_FILE"/);
    expect(block).toContain("COMPANION_AUTODISPATCH_JSON");
    expect(block).not.toContain("autonomy.env left unchanged");
    expect(block.indexOf("TRIAL_ENV_TMP")).toBeLessThan(
      source.indexOf("systemctl --user restart", buildAt),
    );
  });

  it("treats a legacy main-env COMPANION_AUTONOMY_JSON as a migration error", () => {
    const detectAt = source.indexOf("still defines COMPANION_AUTONOMY_JSON");
    expect(detectAt).toBeGreaterThan(-1);
    expect(detectAt).toBeLessThan(buildAt);
    const legacyAt = source.indexOf('"$TRIAL_LEGACY_MAIN_ENV" = "1"');
    const legacyEnd = source.indexOf(
      'elif [ -f "$TRIAL_OPERATOR_INPUT" ]',
      legacyAt,
    );
    expect(legacyAt).toBeGreaterThan(detectAt);
    const block = source.slice(legacyAt, legacyEnd);
    expect(block).not.toContain("build-trial-operator.mts");
    expect(block).toContain("disable-trial-env.mjs");
    expect(block).toContain("overriding legacy main-env value");
    expect(block).toMatch(
      /no usable prior trial config[\s\S]*?rollback[\s\S]*?exit 1/,
    );
    expect(block).toContain("Aborting the deploy before restart");
  });

  it("passes the rollback operator path to the builder for safe pruning", () => {
    expect(source).toContain(
      'COMPANION_TRIAL_ROLLBACK_OPERATOR_FILE="$TRIAL_BACKUP_DIR/operator.json"',
    );
  });
});

describe("build-trial-operator frozen profile fields", () => {
  const source = readFileSync(join(HERE, "build-trial-operator.mts"), "utf8");

  it("copies the frozen allowedPaths and modelRoute into autonomy JSON", () => {
    expect(source).toContain("allowedPaths: [...config.profile.allowedPaths]");
    expect(source).toContain("modelRoute: config.profile.model.route");
  });
});

describe("build-trial-operator failure cleanup", () => {
  const source = readFileSync(join(HERE, "build-trial-operator.mts"), "utf8");

  it("restores owner write permissions before removing a failed root", () => {
    const catchAt = source.lastIndexOf("} catch (err) {");
    expect(catchAt).toBeGreaterThan(-1);
    const block = source.slice(catchAt);
    expect(block).toMatch(/chmod[\s\S]*?u\+rwX[\s\S]*?rmSync\(ROOT/);
  });
});
