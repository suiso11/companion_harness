import { describe, expect, test } from "vitest";
import {
  pairAiLabel,
  personaAiLabel,
  providerLabel,
} from "../src/lib/persona_display.js";

const providers = [
  {
    id: "deepseek" as const,
    label: "DeepSeek",
    suggestedModels: [],
    available: true,
  },
  {
    id: "openai" as const,
    label: "OpenAI",
    suggestedModels: [],
    available: true,
  },
];

describe("persona display helpers", () => {
  test("personaAiLabel names the provider label and model", () => {
    expect(
      personaAiLabel(providers, {
        provider: "deepseek",
        model: "deepseek-flash",
      }),
    ).toBe("DeepSeek · deepseek-flash");
  });

  test("providerLabel falls back to the raw id", () => {
    expect(providerLabel(providers, "local")).toBe("local");
  });

  test("pairAiLabel shows both providers for a two-persona chat", () => {
    expect(pairAiLabel(providers, "deepseek", null)).toBe("DeepSeek");
    expect(pairAiLabel(providers, "deepseek", "openai")).toBe(
      "DeepSeek × OpenAI",
    );
  });
});
