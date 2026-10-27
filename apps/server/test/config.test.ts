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
  parseAutodispatchConfig,
  parseCalendarConfig,
  parseExecutionRecordsConfig,
  parseMarkdownRoots,
  parseMemoryConfig,
  parseModelConfig,
  parseTrialConfig,
  parseVoiceConfig,
  ServerConfigError,
} from "../src/config.js";

function memoryConfigEnv(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executable: process.execPath,
    entry: "/cli.js",
    config: "/mem.json",
    scope: "test-scope",
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    recallLimit: 5,
    idleMs: 30000,
    ...extra,
  };
}

describe("memory config extraction timeout (strict validation)", () => {
  it("defaults extractTimeoutMs to 120000 and keeps the CLI timeoutMs untouched", () => {
    const config = parseMemoryConfig(JSON.stringify(memoryConfigEnv()));
    expect(config).not.toBeNull();
    expect(config?.extractTimeoutMs).toBe(120000);
    expect(config?.timeoutMs).toBe(5000);
  });

  it("accepts an in-bounds extractTimeoutMs", () => {
    const config = parseMemoryConfig(
      JSON.stringify(memoryConfigEnv({ extractTimeoutMs: 300000 })),
    );
    expect(config?.extractTimeoutMs).toBe(300000);
    expect(config?.timeoutMs).toBe(5000);
  });

  it("rejects extractTimeoutMs out of bounds (5000..300000)", () => {
    expect(() =>
      parseMemoryConfig(
        JSON.stringify(memoryConfigEnv({ extractTimeoutMs: 4999 })),
      ),
    ).toThrow("memory extractTimeoutMs is out of bounds");
    expect(() =>
      parseMemoryConfig(
        JSON.stringify(memoryConfigEnv({ extractTimeoutMs: 300001 })),
      ),
    ).toThrow("memory extractTimeoutMs is out of bounds");
  });

  it("rejects a non-integer extractTimeoutMs", () => {
    expect(() =>
      parseMemoryConfig(
        JSON.stringify(memoryConfigEnv({ extractTimeoutMs: 120.5 })),
      ),
    ).toThrow("memory extractTimeoutMs must be an integer");
  });

  it("still rejects unknown keys (strict allowlist includes extractTimeoutMs)", () => {
    expect(() =>
      parseMemoryConfig(
        JSON.stringify(memoryConfigEnv({ extractTimeoutMs: 60000, rogue: 1 })),
      ),
    ).toThrow("memory config has an unknown key");
  });
});

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

  it("accepts a bracketed IPv6 loopback base URL frozen", () => {
    const config = loadServerConfig(
      modelEnv(
        tempDbPath(),
        JSON.stringify({
          adapter: "ollama",
          baseUrl: "http://[::1]:11434/",
          model: "test-model",
        }),
      ),
    );
    expect(config.model?.baseUrl).toBe("http://[::1]:11434");
    expect(Object.isFrozen(config.model)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
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

  it("accepts an optional toolChoice policy and freezes it", () => {
    for (const toolChoice of ["auto", "required"] as const) {
      const config = loadServerConfig(
        modelEnv(
          tempDbPath(),
          JSON.stringify({
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.1:8000",
            model: "m",
            toolChoice,
          }),
        ),
      );
      expect(config.model?.toolChoice).toBe(toolChoice);
      expect(Object.isFrozen(config.model)).toBe(true);
    }
  });

  it("rejects unknown toolChoice values fail-closed", () => {
    for (const toolChoice of ["none", "any", "", 1, null]) {
      expect(() =>
        parseModelConfig(
          JSON.stringify({
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.1:8000",
            model: "m",
            toolChoice,
          }),
        ),
      ).toThrow(ServerConfigError);
    }
  });

  it("accepts an optional reasoningBudgetTokens for openai-compatible only", () => {
    for (const reasoningBudgetTokens of [0, 256, 2_147_483_647]) {
      const config = loadServerConfig(
        modelEnv(
          tempDbPath(),
          JSON.stringify({
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.1:8000",
            model: "m",
            reasoningBudgetTokens,
          }),
        ),
      );
      expect(config.model?.reasoningBudgetTokens).toBe(reasoningBudgetTokens);
      expect(Object.isFrozen(config.model)).toBe(true);
    }
  });

  it("rejects invalid or unsupported reasoningBudgetTokens fail-closed", () => {
    const invalidValues: unknown[] = [
      -1,
      1.5,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
      "256",
      null,
      true,
    ];
    for (const reasoningBudgetTokens of invalidValues) {
      let message = "";
      try {
        parseModelConfig(
          JSON.stringify({
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.1:8000",
            model: "m",
            reasoningBudgetTokens,
          }),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ServerConfigError);
        message = (error as Error).message;
      }
      expect(message).toBe("model reasoning budget is invalid");
      expect(message).not.toContain(String(reasoningBudgetTokens));
    }
    let unsupported = "";
    try {
      parseModelConfig(
        JSON.stringify({
          adapter: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "m",
          reasoningBudgetTokens: 256,
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ServerConfigError);
      unsupported = (error as Error).message;
    }
    expect(unsupported).toBe(
      "model reasoning budget is unsupported by the adapter",
    );
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
        baseUrl: "http://[::2]:11434",
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

  it("rejects apiKey values that are not legal Authorization header values", () => {
    function rawWithKey(apiKey: string): string {
      return JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
        apiKey,
      });
    }
    const rejected = [
      "sk-\u{1F600}-emoji",
      "key\u0000nul",
      "key\u0001c0",
      "key\u001Finvisible",
      "key\twith-tab",
      "abc\r\nX-Injected: 1",
      "line1\nline2",
      "line1\rline2",
      "del\u007Fchar",
      "c1\u0080pad",
      "c1\u009Fapc",
      "latin-beyond\u0100",
      "cjk\u4E2Dkey",
    ];
    for (const apiKey of rejected) {
      let message = "";
      try {
        parseModelConfig(rawWithKey(apiKey));
      } catch (error) {
        expect(error).toBeInstanceOf(ServerConfigError);
        message = (error as Error).message;
      }
      expect(message).toBe("model auth is invalid");
      expect(message).not.toContain(apiKey.slice(0, 8));
      expect(() =>
        loadServerConfig(modelEnv(tempDbPath(), rawWithKey(apiKey))),
      ).toThrow("model auth is invalid");
    }
  });

  it("accepts boundary Latin-1/ASCII apiKey values", () => {
    const boundary = "a\u0020b\u007E\u00A0\u00FF";
    const config = loadServerConfig(
      modelEnv(
        tempDbPath(),
        JSON.stringify({
          adapter: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "m",
          apiKey: boundary,
        }),
      ),
    );
    expect(config.model?.apiKey).toBe(boundary);
    expect(Object.isFrozen(config.model)).toBe(true);
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

// NOTE (C14): added in the C14 composition commit and recorded ADDED, NOT YET
// RUN — the C13–C15 verification pass is deliberately deferred to C15. No
// executed-verification claim is made here.

const HASH = "a".repeat(64);

/** Minimal valid calendar connector hint (stdio, loopback-none). */
function validConnectorHint(): Record<string, unknown> {
  return {
    serverId: "calendar-fake",
    kind: "mcp",
    expectedServerName: "fake-calendar",
    version: "0.0.0-test",
    transport: {
      kind: "stdio",
      // Real child is never spawned by config parsing; tests inject the
      // transport factory. Env allowlist is deliberately absent so the
      // fail-closed parser leaves defaults in place.
      command: "/bin/false",
      envAllowlist: ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"],
    },
    bindings: [
      { upstreamTool: "list-events", canonicalSchemaHash: HASH },
      { upstreamTool: "search-events", canonicalSchemaHash: HASH },
      { upstreamTool: "get-event", canonicalSchemaHash: HASH },
    ],
  };
}

describe("calendar config (C14 strict opt-in, default disabled)", () => {
  it("stays disabled (null) when the env var is unset", () => {
    const env = baseEnv(tempDbPath());
    expect(loadServerConfig(env).calendar).toBeNull();
  });

  it("parses a valid config, applies connector defaults, and deep-freezes", () => {
    const raw = JSON.stringify({
      selection: { calendarId: "cal-primary", account: "ops@example" },
      connector: validConnectorHint(),
    });
    const config = loadServerConfig({
      ...baseEnv(tempDbPath()),
      COMPANION_CALENDAR_JSON: raw,
    });
    expect(config.calendar).not.toBeNull();
    expect(config.calendar?.selection).toEqual({
      calendarId: "cal-primary",
      account: "ops@example",
    });
    // Derived defaults are materialized and frozen.
    expect(config.calendar?.connector.transport.kind).toBe("stdio");
    expect(Object.isFrozen(config.calendar)).toBe(true);
    expect(Object.isFrozen(config.calendar?.selection)).toBe(true);
    expect(Object.isFrozen(config.calendar?.connector)).toBe(true);
  });

  it("rejects malformed / unknown-key / bad-selection configs with fixed messages", () => {
    expect(() => parseCalendarConfig("not-json")).toThrow(ServerConfigError);
    expect(() => parseCalendarConfig("[]")).toThrow(
      "calendar config must be a JSON object",
    );
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({
          selection: { calendarId: "cal" },
          connector: validConnectorHint(),
          adopted: true,
        }),
      ),
    ).toThrow("calendar config has an unknown key");
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({ selection: "cal", connector: validConnectorHint() }),
      ),
    ).toThrow("calendar selection is invalid");
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({
          selection: { calendarId: "cal", credential: "secret" },
          connector: validConnectorHint(),
        }),
      ),
    ).toThrow("calendar selection has an unknown key");
    // No category/authorization field can ever enter through the config hint.
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({
          selection: { calendarId: "cal" },
          connector: {
            ...validConnectorHint(),
            bindings: [
              {
                upstreamTool: "list-events",
                canonicalSchemaHash: HASH,
                category: "read",
              },
            ],
          },
        }),
      ),
    ).toThrow("calendar connector config is invalid");
  });

  it("rejects a connector hint violating the shared MCP schema", () => {
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({
          selection: { calendarId: "cal" },
          connector: {
            ...validConnectorHint(),
            expectedServerName: undefined,
          },
        }),
      ),
    ).toThrow("calendar connector config is invalid");
    expect(() =>
      parseCalendarConfig(
        JSON.stringify({
          selection: { calendarId: "cal" },
          connector: {
            ...validConnectorHint(),
            transport: { kind: "streamable-http", host: "evil.example" },
          },
        }),
      ),
    ).toThrow("calendar connector config is invalid");
  });
});

describe("web search config (COMPANION_WEB_SEARCH_JSON)", () => {
  it("defaults to disabled (off) when unset and freezes the config", () => {
    const config = loadServerConfig(baseEnv(tempDbPath()));
    expect(config.webSearch.enabled).toBe(false);
    expect(Object.isFrozen(config.webSearch)).toBe(true);
  });

  it("parses an enabled loopback SearXNG config", () => {
    const config = loadServerConfig({
      ...baseEnv(tempDbPath()),
      COMPANION_WEB_SEARCH_JSON: JSON.stringify({
        enabled: true,
        searxng_base_url: "http://127.0.0.1:8080",
      }),
    });
    expect(config.webSearch.enabled).toBe(true);
    expect(config.webSearch.searxng_base_url).toBe("http://127.0.0.1:8080");
    expect(config.webSearch.max_results).toBe(5);
  });

  it("fails startup closed on invalid JSON or unknown keys", () => {
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_WEB_SEARCH_JSON: "{not-json",
      }),
    ).toThrow("web search config is invalid");
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_WEB_SEARCH_JSON: JSON.stringify({ enabled: true, nope: 1 }),
      }),
    ).toThrow("web search config is invalid");
    expect(() =>
      loadServerConfig({
        ...baseEnv(tempDbPath()),
        COMPANION_WEB_SEARCH_JSON: JSON.stringify({ enabled: true }),
      }),
    ).toThrow("web search config is invalid");
  });
});

describe("execution records config", () => {
  it("requires an absolute directory and bounds retention", () => {
    expect(parseExecutionRecordsConfig(undefined)).toBeNull();
    expect(
      parseExecutionRecordsConfig(
        JSON.stringify({ directory: "/tmp/private-records" }),
      ),
    ).toEqual({ directory: "/tmp/private-records", retentionDays: 30 });
    for (const raw of [
      "not json",
      JSON.stringify({ directory: "relative/records" }),
      JSON.stringify({ directory: "/tmp/records", retentionDays: -1 }),
      JSON.stringify({ directory: "/tmp/records", retentionDays: 3651 }),
      JSON.stringify({ directory: "/tmp/records", extra: true }),
    ]) {
      expect(() => parseExecutionRecordsConfig(raw)).toThrow(ServerConfigError);
    }
  });

  it("loads the opt-in env and keeps disabled legacy behavior unchanged", () => {
    const env = baseEnv(tempDbPath());
    expect(loadServerConfig(env).executionRecords).toBeNull();
    expect(
      loadServerConfig({
        ...env,
        COMPANION_EXECUTION_RECORDS_JSON: JSON.stringify({
          directory: "/tmp/private-records",
          retentionDays: 7,
        }),
      }).executionRecords,
    ).toEqual({ directory: "/tmp/private-records", retentionDays: 7 });
  });
});

describe("voice config (COMPANION_VOICE_JSON)", () => {
  it("is disabled when unset and defaults the timeout to 30000", () => {
    expect(parseVoiceConfig(undefined)).toBeNull();
    expect(parseVoiceConfig(JSON.stringify({ profile: "shunkin" }))).toEqual({
      profile: "shunkin",
      timeoutMs: 30000,
    });
    expect(
      parseVoiceConfig(
        JSON.stringify({ profile: "shunkin", timeoutMs: 120000 }),
      ),
    ).toEqual({ profile: "shunkin", timeoutMs: 120000 });
  });

  it("fails closed on unknown keys, profiles, and out-of-bounds timeouts", () => {
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ profile: "shunkin", extra: true }),
      JSON.stringify({ profile: "unknown" }),
      JSON.stringify({}),
      JSON.stringify({ profile: "shunkin", timeoutMs: 999 }),
      JSON.stringify({ profile: "shunkin", timeoutMs: 120001 }),
      JSON.stringify({ profile: "shunkin", timeoutMs: 1.5 }),
    ]) {
      expect(() => parseVoiceConfig(raw)).toThrow(ServerConfigError);
    }
  });

  it("loads the opt-in env and keeps disabled legacy behavior unchanged", () => {
    const env = baseEnv(tempDbPath());
    expect(loadServerConfig(env).voice).toBeNull();
    expect(
      loadServerConfig({
        ...env,
        COMPANION_VOICE_JSON: JSON.stringify({
          profile: "shunkin",
          timeoutMs: 5000,
        }),
      }).voice,
    ).toEqual({ profile: "shunkin", timeoutMs: 5000 });
  });
});

describe("autodispatch caps defaults fit the trial runner", () => {
  function trialConfig(perCallTimeoutMs: number) {
    return {
      available: true,
      enabled: true,
      mandatoryChecks: ["lint"],
      configFingerprint: "b".repeat(64),
      sourceRevision: "a".repeat(40),
      currentModel: "test-model",
      disclosedWholeRepoRead: true,
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
      workspaceAlias: "companion-harness",
      allowedPaths: ["apps", "packages"],
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
          perCallTimeoutMs,
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
  }

  function autodispatchConfig() {
    return {
      enabled: true,
      workspaceAlias: "companion-harness",
      sourceRoot: "/synthetic/source",
      operations: ["investigate", "implement"],
      readScopes: ["src"],
      writeScopes: ["src"],
      checks: ["lint"],
      dependencyRoot: "/synthetic/deps",
      bridgeScriptPath: "/opt/bridge.mjs",
      bridgeConfigTemplatePath: "/opt/bridge.template.json",
    };
  }

  it("derives omitted caps field-wise from the trial runner caps", () => {
    const trial = parseTrialConfig(JSON.stringify(trialConfig(60_000)));
    expect(trial).not.toBeNull();
    const autodispatch = parseAutodispatchConfig(
      JSON.stringify(autodispatchConfig()),
      trial,
    );
    expect(autodispatch).not.toBeNull();
    expect(autodispatch?.caps.perCallTimeoutMs).toBeLessThanOrEqual(60_000);
    expect(autodispatch?.caps.maxModelCalls).toBeLessThanOrEqual(8);
    expect(autodispatch?.caps.maxOutputTokens).toBeLessThanOrEqual(256);
  });

  it("still rejects explicit caps that exceed the trial runner caps", () => {
    const trial = parseTrialConfig(JSON.stringify(trialConfig(60_000)));
    expect(() =>
      parseAutodispatchConfig(
        JSON.stringify({
          ...autodispatchConfig(),
          caps: {
            timeoutMs: 60_000,
            maxOutputBytes: 1_000_000,
            maxModelCalls: 9,
            maxOutputTokens: 256,
            perCallTimeoutMs: 5000,
            maxRequestBytes: 1_048_576,
            maxResponseBytes: 1_048_576,
            maxConcurrent: 1,
            jobsPerDay: 3,
            concurrentExecutions: 1,
          },
        }),
        trial,
      ),
    ).toThrow("autodispatch caps must fit trial runner caps");
  });
});
