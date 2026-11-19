<script lang="ts">
// Shared feature navigation: primary destinations stay visible, while the
// developer/operations surfaces live behind a native <details> disclosure.
// <details>/<summary> is keyboard accessible without JS and needs no inline
// handlers (strict CSP safe).
import { DEV_NAV, DEV_NAV_LABEL, PRIMARY_NAV } from "./router.js";

let { activePath = "/" }: { activePath?: string } = $props();

// The disclosure never auto-opens: an open menu overlays the page (it hid
// the /shadow controls and the mobile 新規作成 button). The summary shows
// the active dev page instead, so orientation survives the closed menu.
let activeDev = $derived(
  DEV_NAV.find((item) => item.path === activePath) ?? null,
);

// One local sprite keeps the header markup small; `currentColor` lets the
// icons follow link/active states without per-icon styles.
const ICONS: Record<string, string> = {
  "/": "chat",
  "/chats": "chat",
  "/personas": "sparkles",
  "/memory": "memory",
  "/diary": "book",
  "/tasks": "target",
  "/proposals": "sparkles",
  "/notifications": "bell",
  "/monitor": "monitor",
  "/trials": "flask",
  "/shadow": "eye",
  "/learning": "book",
  "/handoff": "arrow",
};
function iconFor(path: string): string {
  return ICONS[path] ?? "chat";
}
</script>

<svg class="nav-icon-sprite" aria-hidden="true">
  <symbol id="nav-chat" viewBox="0 0 16 16"
    ><path d="M2 2h12v9H7v2H5v-2H2V2Zm2 2v5h8V4H4Z" /></symbol
  >
  <symbol id="nav-memory" viewBox="0 0 16 16"
    ><path d="M3 2h10v3H3V2Zm0 5h10v3H3V7Zm0 5h10v2H3v-2Z" /></symbol
  >
  <symbol id="nav-target" viewBox="0 0 16 16"
    ><path d="M7 1h2v2h3v3h2v2h-2v3H9v2H7v-2H4V8H2V6h2V3h3V1Zm0 5v3h2V6H7Z" /></symbol
  >
  <symbol id="nav-sparkles" viewBox="0 0 16 16"
    ><path d="M7 1h2v4h4v2H9v4H7V7H3V5h4V1Zm5 10h2v2h2v1h-2v2h-2v-2h-2v-1h2v-2Z" /></symbol
  >
  <symbol id="nav-bell" viewBox="0 0 16 16"
    ><path d="M7 1h2v2h3v6h2v2H2V9h2V3h3V1Zm-1 12h4v2H6v-2Z" /></symbol
  >
  <symbol id="nav-monitor" viewBox="0 0 16 16"
    ><path d="M1 2h14v9H9v2h3v2H4v-2h3v-2H1V2Zm2 2v5h10V4H3Z" /></symbol
  >
  <symbol id="nav-flask" viewBox="0 0 16 16"
    ><path d="M5 1h6v2h-1v4l3 5v3H3v-3l3-5V3H5V1Zm1 8-1 2h6l-1-2H6Z" /></symbol
  >
  <symbol id="nav-eye" viewBox="0 0 16 16"
    ><path d="M4 4h8v2h2v4h-2v2H4v-2H2V6h2V4Zm3 2v4h2V6H7Z" /></symbol
  >
  <symbol id="nav-book" viewBox="0 0 16 16"
    ><path d="M2 2h5v1h2V2h5v11H9v1H7v-1H2V2Zm2 2v7h3V4H4Zm5 0v7h3V4H9Z" /></symbol
  >
  <symbol id="nav-arrow" viewBox="0 0 16 16"
    ><path d="M9 3h2v2h2v2h2v2h-2v2h-2v2H9v-2h2V9H1V7h10V5H9V3Z" /></symbol
  >
  <symbol id="nav-dev" viewBox="0 0 16 16"
    ><path d="M7 1h2v2h3v3h2v2h-2v3H9v2H7v-2H4V8H2V6h2V3h3V1Zm-1 5v3h4V6H6Z" /></symbol
  >
</svg>

<nav class="feature-links" aria-label="機能">
  <div class="nav-brand">
    <span class="nav-brand-mark" aria-hidden="true"
      ><svg class="nav-icon"><use href="#nav-sparkles" /></svg></span
    >
    <span class="nav-brand-text">
      <span class="nav-brand-name">Companion</span>
      <span class="nav-brand-sub">ハーネス</span>
    </span>
  </div>
  <p class="nav-section">ワークスペース</p>
  {#each PRIMARY_NAV as item (item.path)}
    <a
      href={item.path}
      class:active={activePath === item.path}
      aria-current={activePath === item.path ? "page" : undefined}
    >
      <svg class="nav-icon" aria-hidden="true"
        ><use href={`#nav-${iconFor(item.path)}`} /></svg
      >
      <span>{item.label}</span>
    </a>
  {/each}
  <details class="feature-links-dev" class:active={activeDev !== null}>
    <summary
      ><svg class="nav-icon" aria-hidden="true"><use href="#nav-dev" /></svg
      ><span>{DEV_NAV_LABEL}{activeDev ? ` · ${activeDev.label}` : ""}</span></summary
    >
    <div class="feature-links-dev-menu">
      {#each DEV_NAV as item (item.path)}
        <a
          href={item.path}
          class:active={activePath === item.path}
          aria-current={activePath === item.path ? "page" : undefined}
        >
          <svg class="nav-icon" aria-hidden="true"
            ><use href={`#nav-${iconFor(item.path)}`} /></svg
          >
          <span>{item.label}</span>
        </a>
      {/each}
    </div>
  </details>
</nav>
