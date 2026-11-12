<script lang="ts">
import AutonomyPanel from "./AutonomyPanel.svelte";
import ChatPage from "./ChatPage.svelte";
import ShadowPanel from "./ShadowPanel.svelte";

// Native shadow page (port of the legacy AV panel). Chat stays mounted
// because the shadow specs interact through the shared session boot and
// the composer-driven run settling; the shadow surface is the
// route-specific content in the shared shell's feature slot (same pattern
// as LearningPage). Only the compact autonomy control mounts here (the
// stop/resume switch the shadow specs drive); purposes and tasks are owned
// by /tasks so the two pages no longer duplicate the whole panel.
</script>

<svelte:head>
  <title>試行の記録 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/shadow">
  {#snippet children()}
    <AutonomyPanel compact />
    <ShadowPanel />
  {/snippet}
</ChatPage>
