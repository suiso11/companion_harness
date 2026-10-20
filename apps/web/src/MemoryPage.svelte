<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import MemoryPanel from "./MemoryPanel.svelte";

// PR-5 first native feature page. Chat stays mounted because the memory flows
// are seeded by a real conversation run (and the e2e composer/biography
// expectations remain identical); the memory surface is the route-specific
// content in the shared shell's feature slot.
</script>

<svelte:head>
  <title>記憶の管理 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/memory">
  {#snippet children()}
    <MemoryPanel />
  {/snippet}
</ChatPage>
