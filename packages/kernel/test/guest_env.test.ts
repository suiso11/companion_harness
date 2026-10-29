// The sealed guest merges the bridge's operator-allowlisted env snapshot into
// the OMP child. These rules decide what can cross that boundary.

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORWARDED_ENV_MAX_BYTES,
  parseForwardedGuestEnv,
  readForwardedGuestEnv,
  writeGuestEnvSnapshot,
} from "../../../scripts/pi-orch-bridge/guest-env.mjs";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("forwarded guest env", () => {
  it("keeps ordinary names and values", () => {
    expect(
      parseForwardedGuestEnv(
        JSON.stringify({
          PI_CODEX_MODEL: "provider/model",
          GH_TOKEN: "token",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        }),
      ),
    ).toEqual({
      PI_CODEX_MODEL: "provider/model",
      GH_TOKEN: "token",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });

  it("drops sealed-runtime names, invalid names, non-strings, and NUL", () => {
    expect(
      parseForwardedGuestEnv(
        JSON.stringify({
          HOME: "/home/u",
          TMPDIR: "/tmp",
          COMPANION_DB_PATH: "/db",
          "bad name": "x",
          NUMERIC: 1,
          NUL: "a\u0000b",
          OK: "v",
        }),
      ),
    ).toEqual({ OK: "v" });
  });

  it("writes only present allowlisted values to a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-guest-env-"));
    tempRoots.push(dir);
    const path = join(dir, "env.json");
    expect(
      writeGuestEnvSnapshot(path, ["ONE", "MISSING"], { ONE: "1" }),
    ).toEqual({ ONE: "1" });
    expect(readForwardedGuestEnv(path)).toEqual({ ONE: "1" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ONE: "1" });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("returns no overrides for invalid, oversized, or missing files", () => {
    expect(parseForwardedGuestEnv("not json")).toEqual({});
    expect(parseForwardedGuestEnv("[]")).toEqual({});
    expect(
      parseForwardedGuestEnv(
        JSON.stringify({ BIG: "x".repeat(FORWARDED_ENV_MAX_BYTES) }),
      ),
    ).toEqual({});
    expect(readForwardedGuestEnv("/nonexistent/companion-env.json")).toEqual(
      {},
    );
    const dir = mkdtempSync(join(tmpdir(), "companion-guest-env-"));
    tempRoots.push(dir);
    const path = join(dir, "env.json");
    writeFileSync(path, JSON.stringify({ ONE: "1" }));
    expect(readForwardedGuestEnv(path)).toEqual({ ONE: "1" });
  });
});
