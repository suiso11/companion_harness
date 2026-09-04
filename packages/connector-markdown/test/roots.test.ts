import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";
import { MarkdownConnectorError } from "../src/errors.js";
import {
  initializeRoots,
  isWithinRealRoot,
  validateRootInputs,
} from "../src/roots.js";

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

describe("roots", () => {
  it("validates inputs and derives deterministic aliases", () => {
    const validated = validateRootInputs([
      { path: "/b vault" },
      { path: "/a vault", alias: "main" },
    ]);
    expect(validated).toEqual([
      { path: "/b vault", alias: "vault-1" },
      { path: "/a vault", alias: "main" },
    ]);
  });

  it("rejects bad configs without leaking paths", () => {
    const badInputs: unknown[][] = [
      [],
      [{ path: "relative/path" }],
      [{ path: "/ok", alias: "bad alias!" }],
      [
        { path: "/a", alias: "dup" },
        { path: "/b", alias: "dup" },
      ],
    ];
    for (const input of badInputs) {
      try {
        validateRootInputs(input as Parameters<typeof validateRootInputs>[0]);
        expect.unreachable("expected invalid_input");
      } catch (error) {
        expect(error).toBeInstanceOf(MarkdownConnectorError);
        const message = (error as Error).message;
        expect(message).toContain("invalid_input");
        expect(message).not.toContain("relative/path");
        expect(message).not.toContain(tmpdir());
      }
    }
  });

  it("initializes real directories and hides absolute paths", async () => {
    const first = scratchDir("md-root-a-");
    const second = scratchDir("md-root-b-");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const roots = await initializeRoots([{ path: first }, { path: second }]);
    expect(roots.map((root) => root.alias).sort()).toEqual([
      "vault-1",
      "vault-2",
    ]);
    expect(
      isWithinRealRoot(
        roots[0]?.realPath as string,
        roots[0]?.realPath as string,
      ),
    ).toBe(true);
    try {
      await initializeRoots([{ path: join(first, "missing-dir") }]);
      expect.unreachable("expected invalid_input");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as Error).message).not.toContain(first);
    }
  });

  it("derives a stable opaque identity independent of input order", async () => {
    const first = scratchDir("md-root-ident-a-");
    const second = scratchDir("md-root-ident-b-");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const one = await createMarkdownConnector([
      { path: first, alias: "alpha" },
      { path: second, alias: "beta" },
    ]);
    const two = await createMarkdownConnector([
      { path: second, alias: "beta" },
      { path: first, alias: "alpha" },
    ]);
    expect(one.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(two.identityFingerprint).toBe(one.identityFingerprint);
    expect(one.roots).toEqual([{ alias: "alpha" }, { alias: "beta" }]);
    expect(JSON.stringify(one)).not.toContain(first);
    expect(JSON.stringify(one)).not.toContain(second);
    expect(JSON.stringify(one)).not.toContain(tmpdir());
  });
});
