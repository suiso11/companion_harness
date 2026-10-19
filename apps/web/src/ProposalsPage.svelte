<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import ProposalsPanel from "./ProposalsPanel.svelte";

// Native proposals page (port of the AV03 legacy panel). Chat stays
// mounted because the proposal specs interact through the shared session
// boot, the composer natural-break seam, and the composer-driven run
// settling; the proposals surface is the route-specific content in the
// shared shell's feature slot (same pattern as LearningPage).
</script>

<svelte:head>
  <title>会話の候補 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/proposals">
  {#snippet children()}
    <ProposalsPanel />
  {/snippet}
</ChatPage>
