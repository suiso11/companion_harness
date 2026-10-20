<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import LearningPanel from "./LearningPanel.svelte";

// Native learning page (port of the AV04 legacy panel). Chat stays mounted
// because the learning specs interact through the shared session boot and
// the composer-driven run settling; the learning surface is the
// route-specific content in the shared shell's feature slot (same pattern
// as AutonomyPage / NotificationsPage).
</script>

<svelte:head>
  <title>学び · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/learning">
  {#snippet children()}
    <LearningPanel />
  {/snippet}
</ChatPage>
