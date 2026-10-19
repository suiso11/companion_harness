// remind deploy helper tests: smoke scope preference (COMPANION_MEMORY_JSON
// scope first, then allowedScopes[0]) and strict ok:true envelope checks.
// Temp-dir config only; no secrets, no network, no production paths.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isOkEnvelope,
  memoryValue,
  readAllowedScope,
  resolveSmokeScope,
  resolveSmokeTarget,
  scopeFromMemoryJson,
} from "../../../scripts/deploy/remindDeploy.mjs";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function writeConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "remind-deploy-"));
  tempDirs.push(dir);
  const path = join(dir, "memory.config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("scopeFromMemoryJson", () => {
  it("reads the Companion address scope", () => {
    const raw = JSON.stringify({
      executable: "/node",
      entry: "/remind/dist/src/cli.js",
      config: "/cfg.json",
      scope: "personal/default",
    });
    expect(scopeFromMemoryJson(raw)).toBe("personal/default");
  });

  it("rejects missing, malformed, and empty scopes", () => {
    expect(scopeFromMemoryJson(undefined)).toBeNull();
    expect(scopeFromMemoryJson("")).toBeNull();
    expect(scopeFromMemoryJson("{")).toBeNull();
    expect(scopeFromMemoryJson("{}")).toBeNull();
    expect(scopeFromMemoryJson('{"scope":""}')).toBeNull();
    expect(scopeFromMemoryJson('{"scope":42}')).toBeNull();
  });
});

describe("memoryValue", () => {
  it("reads non-empty string fields and rejects the rest", () => {
    const raw = JSON.stringify({
      executable: "/node",
      entry: "/remind/dist/src/cli.js",
      config: "/cfg.json",
      scope: "personal/default",
    });
    expect(memoryValue(raw, "entry")).toBe("/remind/dist/src/cli.js");
    expect(memoryValue(raw, "config")).toBe("/cfg.json");
    expect(memoryValue(raw, "missing")).toBeNull();
    expect(memoryValue('{"entry":42}', "entry")).toBeNull();
    expect(memoryValue(undefined, "entry")).toBeNull();
  });
});

describe("resolveSmokeTarget", () => {
  it("uses the Companion address for executable/entry/config/scope", () => {
    const raw = JSON.stringify({
      executable: "/node",
      entry: "/remind/dist/src/cli.js",
      config: "/companion/config.json",
      scope: "companion/scope",
    });
    expect(
      resolveSmokeTarget({
        memoryJson: raw,
        configPath: "/remind/config.json",
        fallbackEntry: "/deploy/dist/src/cli.js",
        fallbackExecutable: "/usr/bin/node",
      }),
    ).toEqual({
      executable: "/node",
      entry: "/remind/dist/src/cli.js",
      config: "/companion/config.json",
      scope: "companion/scope",
    });
  });

  it("falls back to the deployed CLI and config scope", () => {
    const path = writeConfig({ allowedScopes: ["config/scope"] });
    expect(
      resolveSmokeTarget({
        memoryJson: "",
        configPath: path,
        fallbackEntry: "/deploy/dist/src/cli.js",
        fallbackExecutable: "/usr/bin/node",
      }),
    ).toEqual({
      executable: "/usr/bin/node",
      entry: "/deploy/dist/src/cli.js",
      config: path,
      scope: "config/scope",
    });
  });
});

describe("readAllowedScope", () => {
  it("returns the first allowed scope", () => {
    const path = writeConfig({ allowedScopes: ["personal/default", "work"] });
    expect(readAllowedScope(path)).toBe("personal/default");
  });

  it("returns null for missing files, bad JSON, or empty lists", () => {
    expect(readAllowedScope("/nonexistent/memory.config.json")).toBeNull();
    expect(readAllowedScope(undefined)).toBeNull();
    const empty = writeConfig({ allowedScopes: [] });
    expect(readAllowedScope(empty)).toBeNull();
    const missing = writeConfig({});
    expect(readAllowedScope(missing)).toBeNull();
  });
});

describe("resolveSmokeScope", () => {
  it("prefers COMPANION_MEMORY_JSON scope over the config fallback", () => {
    const path = writeConfig({ allowedScopes: ["config/scope"] });
    expect(
      resolveSmokeScope({
        memoryJson: '{"scope":"companion/scope"}',
        configPath: path,
      }),
    ).toBe("companion/scope");
  });

  it("falls back to allowedScopes[0]", () => {
    const path = writeConfig({ allowedScopes: ["config/scope"] });
    expect(resolveSmokeScope({ memoryJson: "{}", configPath: path })).toBe(
      "config/scope",
    );
  });

  it("returns null when neither source is usable", () => {
    expect(resolveSmokeScope({ memoryJson: "", configPath: "/missing" })).toBe(
      null,
    );
  });
});

describe("isOkEnvelope", () => {
  it("accepts a well-formed ok:true envelope", () => {
    expect(
      isOkEnvelope(
        JSON.stringify({
          v: 1,
          ok: true,
          code: "OK",
          message: "ok",
          data: { records: [] },
          deduplicated: false,
        }),
      ),
    ).toBe(true);
  });

  it("rejects domain failures, wrong versions, and non-JSON", () => {
    expect(
      isOkEnvelope(
        JSON.stringify({
          v: 1,
          ok: false,
          code: "FORBIDDEN_SCOPE",
          message: "forbidden scope",
          data: null,
          deduplicated: false,
        }),
      ),
    ).toBe(false);
    expect(isOkEnvelope('{"v":2,"ok":true,"code":"OK"}')).toBe(false);
    expect(isOkEnvelope('{"v":1,"ok":true,"code":"BAD_REQUEST"}')).toBe(false);
    expect(isOkEnvelope("not json")).toBe(false);
    expect(isOkEnvelope("")).toBe(false);
  });
});
