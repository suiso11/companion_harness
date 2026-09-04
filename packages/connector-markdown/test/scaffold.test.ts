import { describe, expect, it } from "vitest";
import { CONNECTOR_MARKDOWN_SCAFFOLD } from "../src/index.js";

describe("connector-markdown scaffold", () => {
  it("exposes the scaffold placeholder", () => {
    expect(CONNECTOR_MARKDOWN_SCAFFOLD).toBe("m1-scaffold");
  });
});
