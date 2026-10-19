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

  test("Safari IME keyCode 229 Enter never sends", () => {
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
        composing: false,
      }),
    ).toBe(false);
  });

  test("Enter immediately after compositionend never sends (both orders)", () => {
    // Order 1: compositionend fired, flag set, keydown arrives with
    // isComposing already false.
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        composing: false,
        justEndedComposition: true,
      }),
    ).toBe(false);
    // Order 2: stale isComposing true on the keydown itself.
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        composing: false,
        justEndedComposition: true,
      }),
    ).toBe(false);
    // After the next tick the flag clears and plain Enter sends again.
    expect(
      shouldSendOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        composing: false,
        justEndedComposition: false,
      }),
    ).toBe(true);
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
