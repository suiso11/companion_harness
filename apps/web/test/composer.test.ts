// V4 composer unit tests: Enter/Shift+Enter/IME handling (DOM-free).
import { describe, expect, test } from "vitest";
import { shouldSendOnKeydown } from "../src/lib/composer.js";

describe("shouldSendOnKeydown", () => {
  test("plain Enter sends", () => {
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        composing: false,
      }),
    ).toBe(true);
  });

  test("Shift+Enter inserts a newline instead of sending", () => {
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        composing: false,
      }),
    ).toBe(false);
  });

  test("IME composition Enter never sends (Japanese input safe)", () => {
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        composing: false,
      }),
    ).toBe(false);
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        composing: true,
      }),
    ).toBe(false);
  });

  test("non-Enter keys never send", () => {
    for (const key of ["a", "Escape", "Tab", " "]) {
      expect(
        shouldSendOnKeydown({
          key,
          shiftKey: false,
          isComposing: false,
          composing: false,
        }),
      ).toBe(false);
    }
  });
});
