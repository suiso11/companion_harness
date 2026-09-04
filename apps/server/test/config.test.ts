// Server config tests: defaults, loopback/host/port/IANA rejection,
// symlink fail-closed behavior, and freeze.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDbPathHasNoSymlink,
  defaultDbPath,
  isIanaTimeZone,
  loadServerConfig,
  ServerConfigError,
} from "../src/config.js";

function baseEnv(dbPath: string): NodeJS.ProcessEnv {
  return {
    COMPANION_DB_PATH: dbPath,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "info",
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-config-"));
  return join(dir, "companion.sqlite");
}

describe("server config defaults", () => {
  it("loads defaults with a frozen object", () => {
    const config = loadServerConfig(baseEnv(tempDbPath()));
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.timeZone).toBe("UTC");
    expect(config.logLevel).toBe("info");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("places the default DB under the OS app-data directory", () => {
    expect(defaultDbPath()).toContain("companion-harness");
    expect(defaultDbPath().endsWith("companion.sqlite")).toBe(true);
  });
});

describe("server config validation", () => {
  it("accepts localhost and rejects non-loopback hosts", () => {
    expect(
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_HOST: "localhost",
      }).host,
    ).toBe("localhost");
    for (const host of ["0.0.0.0", "example.com", "192.168.1.2", ""]) {
      expect(() =>
        loadServerConfig({ ...baseEnv(tempDbPath()), COMPANION_HOST: host }),
      ).toThrow(ServerConfigError);
    }
  });

  it("rejects bad ports", () => {
    for (const port of ["abc", "-1", "70000", "3.5", "80x"]) {
      expect(() =>
        loadServerConfig({ ...baseEnv(tempDbPath()), COMPANION_PORT: port }),
      ).toThrow(ServerConfigError);
    }
  });

  it("validates IANA membership via Intl, not shape", () => {
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("America/New_York")).toBe(true);
    expect(isIanaTimeZone("Not/AZone")).toBe(false);
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_TIME_ZONE: "Not/AZone",
      }),
    ).toThrow(ServerConfigError);
  });

  it("rejects unknown log levels", () => {
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_LOG_LEVEL: "verbose",
      }),
    ).toThrow(ServerConfigError);
  });
});

describe("database symlink fail-closed", () => {
  it("rejects a symlinked DB file and a symlinked parent component", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-symlink-"));
    const realFile = join(dir, "real.sqlite");
    writeFileSync(realFile, "x");
    const linkFile = join(dir, "link.sqlite");
    const linkDir = join(dir, "linkdir");
    try {
      symlinkSync(realFile, linkFile);
      symlinkSync(dir, linkDir);
    } catch {
      // No symlink privilege on this platform: nothing to assert.
      return;
    }
    expect(() => assertDbPathHasNoSymlink(linkFile)).toThrow(ServerConfigError);
    expect(() => assertDbPathHasNoSymlink(join(linkDir, "db.sqlite"))).toThrow(
      ServerConfigError,
    );
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_DB_PATH: linkFile,
      }),
    ).toThrow(ServerConfigError);
  });

  it("accepts a missing DB file under real parents", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-nosymlink-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    const missing = join(dir, "sub", "db.sqlite");
    expect(() => assertDbPathHasNoSymlink(missing)).not.toThrow();
    expect(loadServerConfig(baseEnv(missing)).dbPath).toBe(missing);
  });
});
