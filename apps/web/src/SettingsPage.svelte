<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import { fetchJson, postJson } from "./lib/api.js";
import type { PersonaProviderInfo } from "./lib/persona_chat.js";

let providers = $state<PersonaProviderInfo[]>([]);
let inputs = $state<Record<string, string>>({});
let error = $state("");
let busy = $state(false);

async function load(): Promise<void> {
  const res = await fetchJson("/api/providers");
  if (res.status !== 200) {
    error = "プロバイダーを読み込めませんでした";
    return;
  }
  providers = (res.body as { providers: PersonaProviderInfo[] }).providers;
  error = "";
}
void load();

async function submit(id: string, apiKey: string): Promise<void> {
  if (busy) return;
  busy = true;
  const res = await postJson(`/api/providers/${id}/key`, { apiKey }, null);
  busy = false;
  if (res.status !== 200) {
    error = "APIキーを更新できませんでした";
    return;
  }
  inputs[id] = "";
  await load();
}
</script>

<svelte:head>
  <title>設定 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/settings" chatSurface={false}>
  {#snippet children()}
    <section class="personas" aria-labelledby="settings-title">
      <header>
        <h2 id="settings-title">設定</h2>
      </header>
      <p class="hint">APIキーはこのPCのローカルファイル（権限0600）に保存され、再表示されません。</p>
      {#if error}<p class="banner" role="alert">{error}</p>{/if}
      {#each providers.filter((p) => p.id !== "local") as p (p.id)}
        {@const key = (inputs[p.id] ?? "").trim()}
        <form onsubmit={(e) => { e.preventDefault(); if (key) void submit(p.id, key); }}>
          <strong>{p.label}</strong>
          <small>{p.available ? "設定済み" : "未設定"}</small>
          <label>APIキー<input type="password" autocomplete="off" bind:value={inputs[p.id]} /></label>
          <div class="row">
            <button type="submit" disabled={busy || !key}>保存</button>
            <button type="button" class="danger" disabled={busy} onclick={() => submit(p.id, "")}>削除</button>
          </div>
        </form>
      {/each}
    </section>
  {/snippet}
</ChatPage>

<style>
  .personas { display: grid; gap: 0.75rem; max-width: 40rem; padding: 1rem; }
  header, .row { display: flex; align-items: center; gap: 0.5rem; }
  h2 { margin: 0; font-size: 1.1rem; }
  form { display: grid; gap: 0.6rem; padding: 0.75rem; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
  label { display: grid; gap: 0.25rem; font-size: 0.85rem; }
  input, button { font: inherit; color: var(--foreground); background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.35rem 0.6rem; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .danger { color: var(--destructive); }
  small, .hint { color: var(--muted-foreground); font-size: 0.8rem; margin: 0; }
  .banner { margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--destructive); border-radius: var(--radius-sm); color: var(--destructive); }
</style>
