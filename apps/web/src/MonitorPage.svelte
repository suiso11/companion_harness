<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import MonitorPanel from "./MonitorPanel.svelte";

// Native monitor page (same pattern as the other PR-5 feature pages: the
// shared chat shell stays mounted so the nav/session seams are identical,
// and the route-specific monitor panel fills the feature slot).
</script>

<svelte:head>
  <title>モニター · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/monitor">
  {#snippet children()}
    <MonitorPanel />
  {/snippet}
</ChatPage>
