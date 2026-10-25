// Safe logging fields: fixed gateway code/cause and numeric HTTP status are
// preserved, while unknown strings and out-of-range numbers are dropped.
// Raw messages, prompts, bodies, and secrets are never representable.
import { describe, expect, it } from "vitest";
import { createServerLogger, type LogSink } from "../src/logger.js";

function capture(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  const sink: LogSink = {
    writeStdout: (line) => lines.push(line),
    writeStderr: (line) => lines.push(line),
  };
  return { sink, lines };
}

describe("model.step.failed safe diagnostics", () => {
  it("keeps allowlisted code/cause and a numeric HTTP status", () => {
    const { sink, lines } = capture();
    const logger = createServerLogger("debug", sink);
    logger.warn("model.step.failed", {
      runId: "run-1",
      gatewayErrorCode: "request_failed",
      invalidResponseCause: "response_too_large",
      httpStatus: 503,
    });
    const record = JSON.parse(lines[0] as string);
    expect(record).toMatchObject({
      code: "model.step.failed",
      runId: "run-1",
      gatewayErrorCode: "request_failed",
      invalidResponseCause: "response_too_large",
      httpStatus: 503,
    });
  });

  it("drops unknown codes/causes, out-of-range status, and raw text", () => {
    const { sink, lines } = capture();
    const logger = createServerLogger("debug", sink);
    logger.warn("model.step.failed", {
      runId: "run-2",
      gatewayErrorCode: "raw-provider-body-SECRET" as never,
      invalidResponseCause: "raw-body-SECRET" as never,
      httpStatus: 999,
    });
    const line = lines[0] as string;
    expect(line).not.toContain("SECRET");
    const record = JSON.parse(line);
    expect(record).not.toHaveProperty("gatewayErrorCode");
    expect(record).not.toHaveProperty("invalidResponseCause");
    expect(record).not.toHaveProperty("httpStatus");
  });
});
