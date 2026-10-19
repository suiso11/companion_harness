// V4 composer key handling (adapted from upstream
// `tools/ui/.../ChatForm/ChatFormInput/ChatFormInputBasic.svelte` +
// `utils/autoresize-textarea.ts`, @ 098ce52 — see vendor NOTICE).
//
// Upstream autosizes the textarea and sends on Enter; Shift+Enter inserts
// a newline. The IME guard (`isComposing`) is load-bearing for Japanese
// input: Enter during conversion must confirm the composition, never send.

/** Key subset the send-on-Enter decision needs (testable without DOM). */
export interface ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  /** Safari IME: Enter during conversion reports keyCode 229. */
  readonly keyCode?: number | null;
  readonly composing: boolean;
  /**
   * True on the Enter keydown that immediately follows `compositionend`
   * (Safari fires it with `isComposing === false`). Set on
   * `compositionend`, cleared on the next tick.
   */
  readonly justEndedComposition?: boolean;
}

/**
 * True when this keydown must submit the composer: plain Enter only, never
 * while an IME composition is active, never Shift+Enter (newline), never
 * the Safari keyCode-229 conversion Enter, and never the Enter keydown that
 * immediately follows `compositionend`.
 */
export function shouldSendOnKeydown(input: ComposerKeyInput): boolean {
  if (input.key !== "Enter") {
    return false;
  }
  if (input.shiftKey) {
    return false;
  }
  if (input.isComposing || input.composing) {
    return false;
  }
  if (input.justEndedComposition === true) {
    return false;
  }
  if (input.keyCode === 229) {
    return false;
  }
  return true;
}

/**
 * Grow a textarea to its content, capped at `maxPx` (about 10 lines, then
 * it scrolls). No-op for non-elements so unit tests stay DOM-free.
 */
export function autogrowTextarea(el: unknown, maxPx = 240): void {
  if (
    typeof HTMLElement === "undefined" ||
    !(el instanceof HTMLElement) ||
    !("style" in el)
  ) {
    return;
  }
  const target = el as unknown as HTMLTextAreaElement;
  if (typeof target.style === "undefined" || target.tagName !== "TEXTAREA") {
    return;
  }
  target.style.height = "auto";
  const next = Math.min(target.scrollHeight, maxPx);
  target.style.height = `${next}px`;
  target.style.overflowY = target.scrollHeight > maxPx ? "auto" : "hidden";
}
