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
  MAX_MARKDOWN_ROOTS,
  parseMarkdownRoots,
  parseModelConfig,
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

describe("markdown roots config", () => {
  it("defaults to a frozen empty array", () => {
    const config = loadServerConfig(baseEnv(tempDbPath()));
    expect(config.markdownRoots).toEqual([]);
    expect(Object.isFrozen(config.markdownRoots)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("accepts valid roots and deep-freezes entries", () => {
    const first = mkdtempSync(join(tmpdir(), "companion-vault-a-"));
    const second = mkdtempSync(join(tmpdir(), "companion-vault-b-"));
    const raw = JSON.stringify([
      { path: first, alias: "vault-a" },
      { path: second },
    ]);
    const config = loadServerConfig({
      ...baseEnv(tempDbPath()),
      COMPANION_MARKDOWN_ROOTS_JSON: raw,
    });
    expect(config.markdownRoots).toHaveLength(2);
    expect(Object.isFrozen(config.markdownRoots)).toBe(true);
    for (const entry of config.markdownRoots) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(parseMarkdownRoots("[]")).toEqual([]);
  });

  it("rejects scalar, object, unknown keys, and over-count roots", () => {
    const vault = mkdtempSync(join(tmpdir(), "companion-vault-"));
    for (const bad of [
      '"just-a-string"',
      "42",
      '{"path":"x"}',
      "null",
      JSON.stringify([{ path: vault, alias: "a", extra: 1 }]),
      JSON.stringify([{ path: vault }, "nope"] as unknown[]),
    ]) {
      expect(() =>
        loadServerConfig({
          ...baseEnv(tempDbPath()),
          COMPANION_MARKDOWN_ROOTS_JSON: bad,
        }),
      ).toThrow(ServerConfigError);
    }
    const many = Array.from({ length: MAX_MARKDOWN_ROOTS + 1 }, (_, index) => ({
      path: vault,
      alias: `v${index}`,
    }));
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_MARKDOWN_ROOTS_JSON: JSON.stringify(many),
      }),
    ).toThrow(ServerConfigError);
  });

  it("rejects relative, empty, NUL, overlong, and bad/duplicate aliases", () => {
    const vault = mkdtempSync(join(tmpdir(), "companion-vault-"));
    const overlong = `/${"a".repeat(4097)}`;
    const cases = [
      JSON.stringify([{ path: "relative/path" }]),
      JSON.stringify([{ path: "" }]),
      JSON.stringify([{ path: `${vault}\0x` }]),
      JSON.stringify([{ path: overlong }]),
      JSON.stringify([{ path: vault, alias: "bad/alias" }]),
      JSON.stringify([{ path: vault, alias: "" }]),
      JSON.stringify([
        { path: vault, alias: "ok" },
        { path: vault, alias: "ok" },
      ]),
      JSON.stringify([{ alias: "only-alias" }]),
    ];
    for (const bad of cases) {
      expect(() =>
        loadServerConfig({
          ...baseEnv(tempDbPath()),
          COMPANION_MARKDOWN_ROOTS_JSON: bad,
        }),
      ).toThrow(ServerConfigError);
    }
  });

  it("never exposes raw paths in markdown-roots errors", () => {
    const vault = mkdtempSync(join(tmpdir(), "companion-secret-vault-"));
    let message = "";
    try {
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_MARKDOWN_ROOTS_JSON: JSON.stringify([
          { path: "relative/path" },
        ]),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(vault);
    expect(message).not.toContain("relative/path");
    let relativeMessage = "";
    try {
      parseMarkdownRoots("not-json");
    } catch (error) {
      relativeMessage = (error as Error).message;
    }
    expect(relativeMessage).not.toContain("not-json");
  });
});

describe("model config", () => {
  const SECRET = "sk-test-secret-value-abc123";

  function modelEnv(dbPath: string, value: string): NodeJS.ProcessEnv {
    return { ...baseEnv(dbPath), COMPANION_MODEL_JSON: value };
  }

  it("defaults to null (no model) with a frozen config", () => {
    const config = loadServerConfig(baseEnv(tempDbPath()));
    expect(config.model).toBeNull();
    expect(Object.isFrozen(config)).toBe(true);
    expect(parseModelConfig(undefined)).toBeNull();
  });

  it("accepts both adapters with a normalized loopback URL", () => {
    for (const adapter of ["ollama", "openai-compatible"] as const) {
      const config = loadServerConfig(
        modelEnv(
          tempDbPath(),
          JSON.stringify({
            adapter,
            baseUrl: "http://127.0.0.1:11434/",
            model: "test-model",
          }),
        ),
      );
      expect(config.model?.adapter).toBe(adapter);
      expect(config.model?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(config.model?.model).toBe("test-model");
      expect(config.model?.apiKey).toBeUndefined();
      expect(Object.isFrozen(config.model)).toBe(true);
    }
  });

  it("accepts an optional apiKey and freezes it", () => {
    const config = loadServerConfig(
      modelEnv(
        tempDbPath(),
        JSON.stringify({
          adapter: "ollama",
          baseUrl: "http://localhost:11434",
          model: "m",
          apiKey: SECRET,
        }),
      ),
    );
    expect(config.model?.apiKey).toBe(SECRET);
    expect(Object.isFrozen(config.model)).toBe(true);
  });

  it("rejects malformed model configs fail-closed", () => {
    const bad = [
      "not-json",
      '"just-a-string"',
      "42",
      "null",
      "[]",
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
        extra: 1,
      }),
      JSON.stringify({
        adapter: "anthropic",
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "https://127.0.0.1:11434",
        model: "m",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://example.com",
        model: "m",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434/?q=1",
        model: "m",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
        apiKey: "",
      }),
      JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      }),
    ];
    for (const raw of bad) {
      expect(() => loadServerConfig(modelEnv(tempDbPath(), raw))).toThrow(
        ServerConfigError,
      );
    }
  });

  it("never exposes model values or secrets in errors", () => {
    const raw = JSON.stringify({
      adapter: "ollama",
      baseUrl: "http://127.0.0.1:9999/secret-path",
      model: "m",
      apiKey: SECRET,
      extra: "boom",
    });
    let message = "";
    try {
      parseModelConfig(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("secret-path");
    expect(message).not.toContain("9999");
    let malformed = "";
    try {
      parseModelConfig("{oops");
    } catch (error) {
      malformed = (error as Error).message;
    }
    expect(malformed).not.toContain("{oops");
  });
});
