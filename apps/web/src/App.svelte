<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import { routeForPath } from "./lib/router.js";

// PR-5 route switch. The server serves this same Svelte shell for `/` and
// every feature history route (with auth + strict CSP identical), so the
// route is derived once from `location.pathname`. Chat (`/`) remains the
// untouched Svelte implementation; feature routes mount their dedicated
// surface. Navigation uses real anchors (server routes) so a refresh on any
// page works and the legacy feature client boots against a fresh DOM.
const pathname = typeof location === "undefined" ? "/" : location.pathname;
// `/` (and any unknown path) has no feature route; unknown paths 404 server-side.
const feature = routeForPath(pathname);
</script>

{#if feature === null}
  <ChatPage />
{:else if feature.path === "/memory"}
  {#await import("./MemoryPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/tasks"}
  {#await import("./AutonomyPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/notifications"}
  {#await import("./NotificationsPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/learning"}
  {#await import("./LearningPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/proposals"}
  {#await import("./ProposalsPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/trials"}
  {#await import("./TrialsPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/shadow"}
  {#await import("./ShadowPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/handoff"}
  {#await import("./HandoffPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{:else if feature.path === "/monitor"}
  {#await import("./MonitorPage.svelte") then module}
    <svelte:component this={module.default} />
  {:catch}
    <p>ページを読み込めませんでした</p>
  {/await}
{/if}
