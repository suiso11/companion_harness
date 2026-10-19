<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import HandoffPanel from "./HandoffPanel.svelte";

// Native handoff page (port of the legacy AV03 panel). Chat stays mounted
// because the handoff specs interact through the shared session boot and
// the composer-driven run settling; the handoff surface is the
// route-specific content in the shared shell's feature slot (same pattern
// as LearningPage).
</script>

<svelte:head>
  <title>引継ぎ · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/handoff">
  {#snippet children()}
    <HandoffPanel />
  {/snippet}
</ChatPage>
