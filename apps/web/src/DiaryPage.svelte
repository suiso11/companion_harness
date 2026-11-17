<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import DiaryPanel from "./DiaryPanel.svelte";

// Same shared-shell pattern as MemoryPage: ChatPage stays mounted so the
// header/composer identity is unchanged, and the diary renders in its
// feature slot.
</script>

<svelte:head>
  <title>日記 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/diary">
  {#snippet children()}
    <DiaryPanel />
  {/snippet}
</ChatPage>
