<script lang="ts">
import AutonomyPanel from "./AutonomyPanel.svelte";
import ChatPage from "./ChatPage.svelte";

// PR-5 native autonomy page (port of the legacy AutonomyPanel). Chat stays
// mounted because the autonomy e2e flows are seeded through the composer /
// conversation (and `#composer` must stay visible on /tasks); the autonomy
// surface is the route-specific content in the shared shell's feature slot
// (same pattern as MemoryPage).
</script>

<svelte:head>
  <title>タスク・目的 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/tasks">
  {#snippet children()}
    <AutonomyPanel />
  {/snippet}
</ChatPage>
