<script lang="ts">
import { onMount } from "svelte";
import { fetchJson } from "./lib/api.js";
import {
  type DiaryEntry,
  formatDiaryDay,
  parseDiaryResponse,
} from "./lib/diary.js";
import Markdown from "./lib/Markdown.svelte";

// The companion writes at most one entry per local day, so the panel loads
// once on mount instead of polling.
let entries = $state<DiaryEntry[]>([]);
let status = $state("読み込み中");

onMount(async () => {
  const res = await fetchJson("/api/diary?limit=30");
  if (res.status === 404) {
    status = "日記は無効です";
    return;
  }
  const parsed = res.status === 200 ? parseDiaryResponse(res.body) : null;
  if (parsed === null) {
    status = "error: 日記を取得できませんでした";
    return;
  }
  entries = parsed;
  status = parsed.length === 0 ? "まだ日記はありません" : "";
});
</script>

<section id="diary" aria-label="日記">
  <div class="diary-head">
    <h3>日記</h3>
  </div>
  {#if status.length > 0}
    <p class="diary-notice" role="status">{status}</p>
  {/if}
  {#if entries.length > 0}
    <ol class="diary-list">
      {#each entries as entry (entry.day)}
        <li class="diary-entry">
          <h4 class="diary-day">{formatDiaryDay(entry.day)}</h4>
          <div class="diary-body"><Markdown text={entry.body} /></div>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  #diary {
    margin-top: 1rem;
    border-top: 1px solid var(--border, #333);
    padding-top: 0.75rem;
  }
  .diary-head h3 {
    margin: 0;
  }
  .diary-notice {
    color: var(--muted-foreground, #aaa);
    font-size: 0.85rem;
  }
  .diary-list {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .diary-day {
    margin: 0 0 0.35rem;
  }
  .diary-body {
    border: 1px solid var(--border, #333);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
</style>
