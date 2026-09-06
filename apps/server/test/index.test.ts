import { afterEach, describe, expect, it } from "vitest";
import { handleStartupError } from "../src/index.js";

const savedExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("index top-level startup handler", () => {
  it("sets exit code silently without duplicating server.start_failed", () => {
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (
      process.stderr as unknown as { write: (...args: never[]) => boolean }
    ).write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as (...args: never[]) => boolean;
    try {
      process.exitCode = 0;
      expect(() =>
        handleStartupError(
          Object.assign(new Error("secret /tmp/vault boom"), {
            code: "server_config_invalid",
          }),
        ),
      ).not.toThrow();
      expect(process.exitCode).toBe(1);
      expect(
        lines.filter((line) => line.includes("start_failed")),
      ).toHaveLength(0);
      expect(lines.join("")).not.toContain("/tmp/vault");
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
    }
  });
});
