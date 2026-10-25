// Production AGORA transport failure mapping: a synchronous request-
// construction error (e.g. a registered API key with invalid header
// characters) must settle as the transport's fixed terminal outcome instead
// of escaping as an unhandled rejection.
import { describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:https", () => ({
  request: vi.fn(() => {
    throw Object.assign(new Error("invalid header character"), {
      code: "ERR_INVALID_CHAR",
    });
  }),
}));

import { createAgoraHttpTransport } from "../src/agora_transport.js";
import { ToolError } from "../src/broker.js";

describe("agora http transport", () => {
  it("maps a synchronous request-construction error after DNS to execution_failed", async () => {
    const transport = createAgoraHttpTransport();
    let caught: unknown;
    try {
      await transport.post(
        "/api/threads",
        { title: "T", body: "B" },
        { authorization: "Bearer bad\nkey" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    if (caught instanceof ToolError) {
      expect(caught.errorCode).toBe("execution_failed");
    }
  });
});
