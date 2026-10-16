// M6 create config + profile gates (hermetic, no fork, no net).
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_CONFIG, parseActionConfig } from "../src/config.js";
import {
  CREATE_WRITE_PROFILE_NAME,
  parseCreateWriteConnectorHint,
  parseCreateWriteProfileName,
} from "../src/createWriteProfile.js";

describe("M6 create config/profile gates", () => {
  it("defaults createEnabled to false and rejects unknown keys", () => {
    expect(DEFAULT_ACTION_CONFIG.createEnabled).toBe(false);
    expect(parseActionConfig(undefined).createEnabled).toBe(false);
    expect(parseActionConfig('{"optIn":true,"writeEnabled":true}').createEnabled).toBe(false);
    expect(
      parseActionConfig('{"optIn":true,"writeEnabled":true,"createEnabled":true}').createEnabled,
    ).toBe(true);
    expect(() => parseActionConfig('{"optIn":true,"nope":true}')).toThrow();
  });

  it("parses the create profile selector strictly", () => {
    expect(parseCreateWriteProfileName(undefined)).toBeNull();
    expect(parseCreateWriteProfileName("")).toBeNull();
    expect(parseCreateWriteProfileName(CREATE_WRITE_PROFILE_NAME)).toBe("google-create");
    expect(() => parseCreateWriteProfileName("google-reschedule")).toThrow();
  });

  it("rejects TEST-namespace env names and unknown hint keys", () => {
    expect(() =>
      parseCreateWriteConnectorHint(
        JSON.stringify({ command: "node", args: [], envAllowlist: ["M6_CREATE_TEST_ENDPOINT"] }),
      ),
    ).toThrow();
    expect(() =>
      parseCreateWriteConnectorHint(JSON.stringify({ command: "node", nope: 1 })),
    ).toThrow();
    expect(() => parseCreateWriteConnectorHint(undefined)).toThrow();
  });
});
