<script lang="ts">
import { onMount } from "svelte";
import { fetchJson } from "./lib/api.js";
import {
  type DiaryEntry,
  diarySnippet,
  formatMonth,
  monthCells,
  parseDiaryResponse,
  shiftMonth,
} from "./lib/diary.js";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const now = new Date();
let month = $state(
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
);
let entries = $state<Map<string, DiaryEntry>>(new Map());
let status = $state("読み込み中");
// Guards against an older month response landing after a newer click.
let requestSeq = 0;

const rows = $derived.by(() => {
  const cells = monthCells(month);
  return Array.from({ length: cells.length / 7 }, (_, i) =>
    cells.slice(i * 7, i * 7 + 7),
  );
});

async function load(target: string): Promise<void> {
  const seq = ++requestSeq;
  status = "読み込み中";
  entries = new Map();
  const res = await fetchJson(`/api/diary?month=${target}`);
  if (seq !== requestSeq) return;
  if (res.status === 404) {
    status = "日記は無効です";
    return;
  }
  const parsed = res.status === 200 ? parseDiaryResponse(res.body) : null;
  if (parsed === null) {
    status = "error: 日記を取得できませんでした";
    return;
  }
  entries = new Map(parsed.map((entry) => [entry.day, entry]));
  status = parsed.length === 0 ? "この月の日記はまだありません" : "";
}

function move(delta: number): void {
  month = shiftMonth(month, delta);
  void load(month);
}

// The companion writes at most one entry per local day: load per month, no polling.
onMount(() => {
  void load(month);
});
</script>

<section id="diary" aria-label="日記">
  <div class="diary-head">
    <button type="button" onclick={() => move(-1)}>前月</button>
    <h3>{formatMonth(month)}</h3>
    <button type="button" onclick={() => move(1)}>次月</button>
  </div>
  {#if status.length > 0}
    <p class="diary-notice" role="status">{status}</p>
  {/if}
  <table class="diary-calendar">
    <thead>
      <tr>
        {#each WEEKDAYS as weekday (weekday)}
          <th scope="col">{weekday}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, index (index)}
        <tr>
          {#each row as day, col (col)}
            <td>
              {#if day !== null}
                {@const entry = entries.get(day)}
                <a href={`/diary/${day}`} class:has-entry={entry !== undefined}>
                  <span class="diary-date">{Number(day.slice(8))}</span>
                  {#if entry !== undefined}
                    <span class="diary-snippet">{diarySnippet(entry.body)}</span>
                  {/if}
                </a>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  #diary {
    margin-top: 1rem;
    border-top: 1px solid var(--border, #333);
    padding-top: 0.75rem;
  }
  .diary-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .diary-head h3 {
    margin: 0;
  }
  .diary-notice {
    color: var(--muted-foreground, #aaa);
    font-size: 0.85rem;
  }
  .diary-calendar {
    width: 100%;
    margin-top: 0.75rem;
    border-collapse: collapse;
    table-layout: fixed;
  }
  th,
  td {
    border: 1px solid var(--border, #333);
    padding: 0;
    vertical-align: top;
  }
  th {
    padding: 0.25rem;
    font-size: 0.8rem;
    font-weight: 600;
  }
  td a {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-height: 4rem;
    padding: 0.3rem;
    color: inherit;
    text-decoration: none;
  }
  td a:hover {
    background: var(--muted, rgba(127, 127, 127, 0.15));
  }
  .diary-date {
    font-size: 0.8rem;
  }
  .has-entry .diary-date {
    font-weight: 700;
  }
  .diary-snippet {
    font-size: 0.7rem;
    color: var(--muted-foreground, #aaa);
    overflow-wrap: anywhere;
  }
</style>
