<script lang="ts">
interface Props {
  open: boolean;
  sessions: string[];
  summaries: Array<{ id: string; title: string; lastTurnKind: string | null }>;
  sessionId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}
const {
  open,
  sessions,
  summaries,
  sessionId,
  disabled,
  onSelect,
  onNew,
  onClose,
}: Props = $props();

let drawer = $state<HTMLElement>();
let closeBtn = $state<HTMLButtonElement>();
let returnTo: HTMLElement | null = null;

const byId = $derived(new Map(summaries.map((s) => [s.id, s])));

$effect(() => {
  if (open) {
    returnTo = document.activeElement as HTMLElement | null;
    closeBtn?.focus();
  } else if (returnTo) {
    if (returnTo.isConnected) returnTo.focus();
    returnTo = null;
  }
});

function onKeydown(e: KeyboardEvent) {
  if (!open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
    return;
  }
  if (e.key !== "Tab" || !drawer) return;
  const items = [
    ...drawer.querySelectorAll<HTMLElement>("button:not(:disabled)"),
  ];
  const first = items[0];
  const last = items[items.length - 1];
  if (!last) return;
  const active = document.activeElement;
  if (!first || !drawer.contains(active)) {
    e.preventDefault();
    first?.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" class:open aria-hidden="true" onclick={onClose}></div>
<div
  class="drawer"
  class:open
  bind:this={drawer}
  role="dialog"
  aria-modal="true"
  aria-labelledby="session-sidebar-title"
  inert={!open}
>
  <header>
    <h2 id="session-sidebar-title">会話一覧 <small>{sessions.length}</small></h2>
    <button type="button" bind:this={closeBtn} onclick={onClose} aria-label="閉じる">✕</button>
  </header>
  <button type="button" class="new" {disabled} onclick={onNew}>＋ 新しい会話</button>
  {#if sessions.length === 0}
    <p class="empty">会話がありません</p>
  {:else}
    <ul>
      {#each sessions as id, i (id)}
        {@const s = byId.get(id)}
        {@const current = id === sessionId}
        <li style:--i={Math.min(i, 12)}>
          <button
            type="button"
            class="row"
            class:current
            {disabled}
            aria-current={current ? "page" : undefined}
            data-session-id={id}
            onclick={() => onSelect(id)}
          >
            <span class="title">{s?.title || id.slice(0, 8)}</span>
            {#if !current && s?.lastTurnKind === "companion_text"}<span class="badge">自発</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: color-mix(in oklch, var(--background) 55%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .backdrop.open {
    opacity: 1;
    pointer-events: auto;
  }
  .drawer {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 101;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(86vw, 20rem);
    padding: 0.75rem;
    background: var(--popover);
    color: var(--foreground);
    border-right: 1px solid var(--border);
    transform: translateX(-100%);
    transition:
      transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
      visibility 0s linear 0.28s;
    visibility: hidden;
  }
  .drawer.open {
    transform: none;
    visibility: visible;
    transition-delay: 0s;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  h2 small {
    color: var(--muted-foreground);
    font-weight: 400;
  }
  button {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--foreground);
    padding: 0.35rem 0.6rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-foreground);
  }
  button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .new {
    background: var(--secondary);
    color: var(--secondary-foreground);
    border-radius: var(--radius-md);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  li {
    opacity: 0;
    transform: translateX(-0.75rem);
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  .drawer.open li {
    opacity: 1;
    transform: none;
    transition-delay: calc(var(--i) * 30ms + 100ms);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    border-radius: var(--radius-md);
  }
  .row.current {
    border-color: var(--ring);
    background: var(--secondary);
    color: var(--secondary-foreground);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-xl);
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .empty {
    color: var(--muted-foreground);
    text-align: center;
    margin: 1rem 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer,
    li {
      transform: none;
    }
    .drawer,
    .backdrop,
    li {
      transition-duration: 0s;
      transition-delay: 0s;
    }
    .drawer:not(.open) {
      opacity: 0;
    }
  }
</style>
