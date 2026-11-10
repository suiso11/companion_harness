import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedPersonaProvider } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderKeyStore } from "../src/provider_keys.js";

const NO_ENV: Record<HostedPersonaProvider, string | null> = {
  openai: null,
  deepseek: null,
  opencode: null,
};
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "provider-keys-"));
  file = join(dir, "provider-keys.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (env = NO_ENV) => createProviderKeyStore({ filePath: file, env });

describe("provider key store", () => {
  it("loads env values when the file is absent", () => {
    expect(open({ ...NO_ENV, openai: "sk-env" }).keys).toEqual({
      ...NO_ENV,
      openai: "sk-env",
    });
  });

  it("persists a set key and reloads it", () => {
    open().set("opencode", "sk-saved");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(open().keys.opencode).toBe("sk-saved");
  });

  it("persists only UI-saved keys, never env keys", () => {
    open({ ...NO_ENV, opencode: "sk-env" }).set("openai", "sk-saved");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      openai: "sk-saved",
    });
  });

  it("clear removes the key from memory and file", () => {
    const store = open();
    store.set("deepseek", "sk-saved");
    store.clear("deepseek");
    expect(store.keys.deepseek).toBeNull();
    expect(open().keys.deepseek).toBeNull();
  });

  it("file value overrides env", () => {
    writeFileSync(file, JSON.stringify({ openai: "sk-file" }), { mode: 0o600 });
    expect(open({ ...NO_ENV, openai: "sk-env" }).keys.openai).toBe("sk-file");
  });

  it("rejects an invalid key", () => {
    expect(() => open().set("openai", "bad key")).toThrow();
  });

  it("fails closed on a bad key file", () => {
    writeFileSync(file, "{nope", { mode: 0o600 });
    expect(() => open()).toThrow();
    writeFileSync(file, JSON.stringify({ mystery: "sk-x" }), { mode: 0o600 });
    expect(() => open()).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a group/other-readable file and accepts 0600",
    () => {
      writeFileSync(file, JSON.stringify({ openai: "sk-x" }));
      chmodSync(file, 0o644);
      expect(() => open()).toThrow();
      chmodSync(file, 0o600);
      expect(open().keys.openai).toBe("sk-x");
    },
  );
});
