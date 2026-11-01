// The appliance observation attached to a camera turn is machine-generated:
// it must reach the model as an attributed observation and never become part
// of the user's request text (which memory intake would learn as speech).
import { describe, expect, test } from "vitest";
import {
  MAX_OBSERVATION_LENGTH,
  projectPrompt,
  renderObservation,
} from "../src/agent.js";

describe("renderObservation", () => {
  test("keeps a bounded description and strips control characters", () => {
    expect(
      renderObservation({ observation: "  机に湯呑みがあります \n" }),
    ).toBe("机に湯呑みがあります");
    expect(renderObservation({ observation: "a\u0000b\u007f" })).toBe("a b");
  });

  test("drops missing, non-string, empty and oversize values", () => {
    expect(renderObservation({})).toBeNull();
    expect(renderObservation({ observation: 42 })).toBeNull();
    expect(renderObservation({ observation: "   " })).toBeNull();
    expect(
      renderObservation({
        observation: "x".repeat(MAX_OBSERVATION_LENGTH + 1),
      }),
    ).toBeNull();
  });
});

describe("projectPrompt observation", () => {
  const base = {
    history: [],
    references: [],
    tools: [],
    model: "test",
  } as const;

  test("renders the observation after the request, attributed to the camera", () => {
    const request = projectPrompt({
      ...base,
      requestText: "カメラを見て",
      observation: "机に湯呑みがあります",
    });
    const user = request.messages.at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("User request:\nカメラを見て");
    expect(user?.content).toContain("machine-generated");
    expect(user?.content).toContain("机に湯呑みがあります");
  });

  test("omits the observation when the turn carries none", () => {
    const request = projectPrompt({ ...base, requestText: "こんにちは" });
    expect(request.messages.at(-1)?.content).not.toContain("machine-generated");
    expect(request.messages[0]?.content).not.toContain("machine-generated");
  });
});
