<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import CharacterPanel from "./CharacterPanel.svelte";

// Character page (same pattern as the other PR-5 feature pages: the shared
// chat shell stays mounted so nav/session seams are identical, and the
// character panel fills the feature slot).
</script>

<svelte:head>
  <title>キャラクター · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/character">
  {#snippet children()}
    <CharacterPanel />
  {/snippet}
</ChatPage>
