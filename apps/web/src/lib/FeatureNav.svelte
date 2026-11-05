<script lang="ts">
// Shared feature navigation: primary destinations stay visible, while the
// developer/operations surfaces live behind a native <details> disclosure.
// <details>/<summary> is keyboard accessible without JS and needs no inline
// handlers (strict CSP safe).
import { DEV_NAV, DEV_NAV_LABEL, PRIMARY_NAV } from "./router.js";

let { activePath = "/" }: { activePath?: string } = $props();

// One local sprite keeps the header markup small; `currentColor` lets the
// icons follow link/active states without per-icon styles.
const ICONS: Record<string, string> = {
  "/": "chat",
  "/memory": "memory",
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
  <symbol id="nav-chat" viewBox="0 0 24 24"
    ><path d="M20 14a3 3 0 0 1-3 3H8l-4 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z" /></symbol
  >
  <symbol id="nav-memory" viewBox="0 0 24 24"
    ><ellipse cx="12" cy="5" rx="8" ry="3" /><path
      d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"
    /></symbol
  >
  <symbol id="nav-target" viewBox="0 0 24 24"
    ><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path
      d="M12 2v3M12 19v3M2 12h3M19 12h3"
    /></symbol
  >
  <symbol id="nav-sparkles" viewBox="0 0 24 24"
    ><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" /><path
      d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z"
    /></symbol
  >
  <symbol id="nav-bell" viewBox="0 0 24 24"
    ><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path
      d="M10 21h4"
    /></symbol
  >
  <symbol id="nav-monitor" viewBox="0 0 24 24"
    ><rect x="3" y="4" width="18" height="13" rx="2" /><path
      d="M8 21h8M12 17v4"
    /></symbol
  >
  <symbol id="nav-flask" viewBox="0 0 24 24"
    ><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path
      d="M7 15h10"
    /></symbol
  >
  <symbol id="nav-eye" viewBox="0 0 24 24"
    ><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle
      cx="12"
      cy="12"
      r="3"
    /></symbol
  >
  <symbol id="nav-book" viewBox="0 0 24 24"
    ><path
      d="M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4ZM20 4h-7a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h7Z"
    /></symbol
  >
  <symbol id="nav-arrow" viewBox="0 0 24 24"
    ><path d="M4 12h16M13 5l7 7-7 7" /></symbol
  >
  <symbol id="nav-dev" viewBox="0 0 24 24"
    ><circle cx="12" cy="12" r="3" /><path
      d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"
    /></symbol
  >
</svg>

<nav class="feature-links" aria-label="機能">
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
  <details
    class="feature-links-dev"
    open={DEV_NAV.some((item) => item.path === activePath)}
  >
    <summary
      ><svg class="nav-icon" aria-hidden="true"><use href="#nav-dev" /></svg
      ><span>{DEV_NAV_LABEL}</span></summary
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
