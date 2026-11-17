<script lang="ts">
import { onMount } from "svelte";
import { fetchJson } from "./lib/api.js";
import {
  type DiaryEntry,
  formatDiaryDay,
  parseDiaryEntryResponse,
} from "./lib/diary.js";
import Markdown from "./lib/Markdown.svelte";

let { day }: { day: string } = $props();

let entry = $state<DiaryEntry | null>(null);
let status = $state("読み込み中");

// One entry per local day; the route (and so `day`) is fixed per page load.
onMount(async () => {
  const res = await fetchJson(`/api/diary/${day}`);
  if (res.status === 404) {
    status = "日記は無効です";
    return;
  }
  const parsed =
    res.status === 200 ? parseDiaryEntryResponse(res.body) : undefined;
  if (parsed === undefined) {
    status = "error: 日記を取得できませんでした";
    return;
  }
  entry = parsed;
  status = parsed === null ? "この日の日記はまだありません" : "";
});
</script>

<section id="diary" aria-label="日記">
  <p><a href="/diary">カレンダーへ戻る</a></p>
  <h2>{formatDiaryDay(day)}</h2>
  {#if status.length > 0}
    <p class="diary-notice" role="status">{status}</p>
  {/if}
  {#if entry !== null}
    <div class="diary-body"><Markdown text={entry.body} /></div>
  {/if}
</section>

<style>
  #diary {
    margin-top: 1rem;
    border-top: 1px solid var(--border, #333);
    padding-top: 0.75rem;
  }
  .diary-notice {
    color: var(--muted-foreground, #aaa);
    font-size: 0.85rem;
  }
  .diary-body {
    border: 1px solid var(--border, #333);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
</style>
