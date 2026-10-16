// M6 create config + profile gates (hermetic, no fork, no net).
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_CONFIG, parseActionConfig } from "../src/config.js";
import {
  assertCreateWriteAccountCompatible,
  assertCreateWriteReadonlyPathVisible,
  CREATE_WRITE_ACCOUNT_ENV,
  CREATE_WRITE_CLIENT_ENV,
  CREATE_WRITE_PROFILE_NAME,
  CREATE_WRITE_READONLY_TOKEN_ENV,
  CREATE_WRITE_TOKEN_PATH_ENV,
  parseCreateWriteConnectorHint,
  parseCreateWriteProfileName,
} from "../src/createWriteProfile.js";

describe("M6 create config/profile gates", () => {
  it("defaults createEnabled to false and rejects unknown keys", () => {
    expect(DEFAULT_ACTION_CONFIG.createEnabled).toBe(false);
    expect(parseActionConfig(undefined).createEnabled).toBe(false);
    expect(
      parseActionConfig('{"optIn":true,"writeEnabled":true}').createEnabled,
    ).toBe(false);
    expect(
      parseActionConfig(
        '{"optIn":true,"writeEnabled":true,"createEnabled":true}',
      ).createEnabled,
    ).toBe(true);
    expect(() => parseActionConfig('{"optIn":true,"nope":true}')).toThrow();
  });

  it("parses the create profile selector strictly", () => {
    expect(parseCreateWriteProfileName(undefined)).toBeNull();
    expect(parseCreateWriteProfileName("")).toBeNull();
    expect(parseCreateWriteProfileName(CREATE_WRITE_PROFILE_NAME)).toBe(
      "google-create",
    );
    expect(() => parseCreateWriteProfileName("google-reschedule")).toThrow();
  });

  it("rejects TEST-namespace env names and unknown hint keys", () => {
    expect(() =>
      parseCreateWriteConnectorHint(
        JSON.stringify({
          command: "node",
          args: [],
          envAllowlist: ["M6_CREATE_TEST_ENDPOINT"],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseCreateWriteConnectorHint(
        JSON.stringify({ command: "node", nope: 1 }),
      ),
    ).toThrow();
    expect(() => parseCreateWriteConnectorHint(undefined)).toThrow();
  });

  it("reuses the shared write-grant wiring names (no M6_CREATE_* credential namespace)", () => {
    expect(CREATE_WRITE_ACCOUNT_ENV).toBe("M5_RESCHEDULE_ACCOUNT");
    expect(CREATE_WRITE_TOKEN_PATH_ENV).toBe("M5_RESCHEDULE_WRITE_TOKEN_PATH");
    expect(CREATE_WRITE_CLIENT_ENV).toBe("GOOGLE_OAUTH_CREDENTIALS");
    expect(CREATE_WRITE_READONLY_TOKEN_ENV).toBe(
      "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH",
    );
  });

  it("gates the configured shared account against the active selection", () => {
    expect(() =>
      assertCreateWriteAccountCompatible(undefined, "work"),
    ).not.toThrow();
    expect(() =>
      assertCreateWriteAccountCompatible("work", "work"),
    ).not.toThrow();
    expect(() => assertCreateWriteAccountCompatible("work", "other")).toThrow(
      /does not match/,
    );
    expect(() => assertCreateWriteAccountCompatible("Work", "Work")).toThrow(
      /invalid/,
    );
  });

  it("requires readonly-path visibility when a custom readonly path is configured", () => {
    const hint = (envAllowlist: readonly string[]) =>
      parseCreateWriteConnectorHint(
        JSON.stringify({ command: "node", args: [], envAllowlist }),
      );
    expect(() =>
      assertCreateWriteReadonlyPathVisible(
        hint([CREATE_WRITE_READONLY_TOKEN_ENV]),
        { [CREATE_WRITE_READONLY_TOKEN_ENV]: "/tmp/readonly.json" },
      ),
    ).not.toThrow();
    expect(() =>
      assertCreateWriteReadonlyPathVisible(hint([]), {
        [CREATE_WRITE_READONLY_TOKEN_ENV]: "/tmp/readonly.json",
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      assertCreateWriteReadonlyPathVisible(hint([]), {}),
    ).not.toThrow();
  });
});
