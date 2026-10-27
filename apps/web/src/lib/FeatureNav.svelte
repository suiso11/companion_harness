<script lang="ts">
// Shared feature navigation: primary destinations stay visible, while the
// developer/operations surfaces live behind a native <details> disclosure.
// <details>/<summary> is keyboard accessible without JS and needs no inline
// handlers (strict CSP safe).
import { DEV_NAV, DEV_NAV_LABEL, PRIMARY_NAV } from "./router.js";

let { activePath = "/" }: { activePath?: string } = $props();
</script>

<nav class="feature-links" aria-label="機能">
  {#each PRIMARY_NAV as item (item.path)}
    <a
      href={item.path}
      class:active={activePath === item.path}
      aria-current={activePath === item.path ? "page" : undefined}
      >{item.label}</a
    >
  {/each}
  <details
    class="feature-links-dev"
    open={DEV_NAV.some((item) => item.path === activePath)}
  >
    <summary>{DEV_NAV_LABEL}</summary>
    <div class="feature-links-dev-menu">
      {#each DEV_NAV as item (item.path)}
        <a
          href={item.path}
          class:active={activePath === item.path}
          aria-current={activePath === item.path ? "page" : undefined}
          >{item.label}</a
        >
      {/each}
    </div>
  </details>
</nav>
