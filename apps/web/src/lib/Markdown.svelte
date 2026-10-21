<script lang="ts">
import {
  CODE_COPY_BUTTON_CLASS,
  loadHighlightLanguages,
  renderAnswerMarkdown,
} from "./markdown.js";

interface Props {
  /** One VALIDATED answer part (never draft/notice/citation text). */
  text: string;
}

let { text }: Props = $props();

// Highlight grammars live in a lazy chunk (entry budget): the first fenced
// code block triggers the load, and `highlightReady` re-runs the derived
// render so the block upgrades from static source to highlighted spans.
// The DOM contract (`hljs` spans, copy chrome) is identical after load.
let highlightReady = $state(false);

$effect(() => {
  if (!text.includes("```")) return;
  void loadHighlightLanguages().then(() => {
    highlightReady = true;
  });
});

const html = $derived.by(() => {
  // Reactive dependency: a completed (or already-done) grammar load
  // re-renders with highlighting enabled.
  highlightReady;
  return renderAnswerMarkdown(text);
});

// Copy-button "copied" reset timer: rapid clicks must clear the previous
// timeout, otherwise the first timer restores the label early (review #84).
let copyResetTimer: number | null = null;

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const button =
    target !== null && typeof target.closest === "function"
      ? (target.closest(
          `.${CODE_COPY_BUTTON_CLASS}`,
        ) as HTMLButtonElement | null)
      : null;
  if (button === null) return;
  const codeId = button.getAttribute("data-code-id");
  if (codeId === null || codeId.length === 0) return;
  const root = button.closest(".answer-markdown");
  const code = root?.querySelector(`code[data-code-id="${codeId}"]`);
  const raw = code?.textContent ?? "";
  if (raw.length === 0) return;
  event.preventDefault();
  void copyText(raw).then((ok) => {
    if (!ok) return;
    const label = button.textContent;
    button.textContent = "コピー済み";
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      button.textContent = label;
      copyResetTimer = null;
    }, 1200);
  });
}
</script>

<!-- Copy-button clicks are delegated from real <button> elements (keyboard
     operable); the container handler only routes them. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="answer-markdown" data-markdown="true" onclick={onClick}>
  {@html html}
</div>
