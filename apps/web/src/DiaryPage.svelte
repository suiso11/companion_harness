<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import DiaryCalendar from "./DiaryCalendar.svelte";
import DiaryDay from "./DiaryDay.svelte";

// Same shared-shell pattern as MemoryPage: ChatPage stays mounted so the
// header/composer identity is unchanged, and the diary renders in its
// feature slot. `/diary` is the calendar, `/diary/<day>` the day page.
let { day = undefined }: { day?: string | undefined } = $props();
</script>

<svelte:head>
  <title>日記 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/diary">
  {#snippet children()}
    {#if day === undefined}
      <DiaryCalendar />
    {:else}
      <DiaryDay {day} />
    {/if}
  {/snippet}
</ChatPage>
