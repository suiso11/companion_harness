<script lang="ts">
import ChatPage from "./ChatPage.svelte";
import { fetchJson, postJson } from "./lib/api.js";
import {
  deleteJson,
  type Persona,
  type PersonaProvider,
  type PersonaProviderInfo,
  patchJson,
  putJson,
} from "./lib/persona_chat.js";
import { personaAiLabel } from "./lib/persona_display.js";

let personas = $state<Persona[]>([]);
let providers = $state<PersonaProviderInfo[]>([]);
let loaded = $state(false);
let error = $state("");
let saving = $state(false);

// editingId: null = form closed, "" = creating, otherwise the persona id.
let editingId = $state<string | null>(null);
let name = $state("");
let avatar = $state("");
let provider = $state<PersonaProvider>("openai");
let model = $state("");
let systemPrompt = $state("");

const info = $derived(providers.find((p) => p.id === provider));
const valid = $derived(
  name.trim().length > 0 &&
    name.length <= 80 &&
    [...avatar].length >= 1 &&
    [...avatar].length <= 16 &&
    model.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    systemPrompt.length <= 8000,
);

async function load(): Promise<void> {
  const res = await fetchJson("/api/personas");
  if (res.status !== 200) {
    error = "ペルソナを読み込めませんでした";
  } else {
    const body = res.body as {
      personas: Persona[];
      providers: PersonaProviderInfo[];
    };
    personas = body.personas;
    providers = body.providers;
    error = "";
  }
  loaded = true;
}
void load();

// Appended to the main AI's fixed system prompt; separate state so a failure
// here never blanks the persona list.
let mainInstructions = $state("");
let mainLoaded = $state(false);
let mainSaving = $state(false);
let mainStatus = $state<"" | "saved" | "failed" | "loadFailed">("");

async function loadMain(): Promise<void> {
  const res = await fetchJson("/api/main-persona");
  if (res.status === 200) {
    mainInstructions = (res.body as { instructions: string }).instructions;
    mainLoaded = true;
  } else {
    mainStatus = "loadFailed";
  }
}
void loadMain();

async function saveMain(event: Event): Promise<void> {
  event.preventDefault();
  if (!mainLoaded || mainSaving) return;
  mainSaving = true;
  // Preserve text exactly; whitespace-only counts as cleared.
  const instructions = mainInstructions.trim() === "" ? "" : mainInstructions;
  const res = await putJson("/api/main-persona", { instructions });
  mainSaving = false;
  if (res.status === 200) {
    mainInstructions = (res.body as { instructions: string }).instructions;
    mainStatus = "saved";
  } else {
    mainStatus = "failed";
  }
}

function openForm(p: Persona | null): void {
  editingId = p?.id ?? "";
  name = p?.name ?? "";
  avatar = p?.avatar ?? "";
  provider = p?.provider ?? providers.find((x) => x.available)?.id ?? "openai";
  model = p?.model ?? "";
  systemPrompt = p?.systemPrompt ?? "";
}

async function save(event: Event): Promise<void> {
  event.preventDefault();
  if (!valid || saving) return;
  saving = true;
  const payload = { name, avatar, provider, model, systemPrompt };
  const res =
    editingId === ""
      ? await postJson("/api/personas", payload, null)
      : await patchJson(`/api/personas/${editingId}`, payload);
  saving = false;
  if (res.status !== 200 && res.status !== 201) {
    error = "保存できませんでした";
    return;
  }
  editingId = null;
  await load();
}

async function remove(p: Persona): Promise<void> {
  if (!confirm("このペルソナと会話履歴をすべて削除します。よろしいですか？"))
    return;
  const res = await deleteJson(`/api/personas/${p.id}`);
  if (res.status !== 200) {
    error = "削除できませんでした";
    return;
  }
  await load();
}
</script>

<svelte:head>
  <title>ペルソナ · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/personas" chatSurface={false}>
  {#snippet children()}
    <section class="personas" aria-labelledby="personas-title">
      <header>
        <h2 id="personas-title">ペルソナ</h2>
        <button type="button" onclick={() => openForm(null)}>新規作成</button>
      </header>

      <form class="main-persona" onsubmit={saveMain} aria-labelledby="main-persona-title">
        <h3 id="main-persona-title">メインAIのペルソナ</h3>
        <p class="hint">基本の安全指示に追記されます（置き換えではありません）。次回のチャットから反映されます。空にして保存すると追記が削除されます。</p>
        <textarea
          rows="5"
          maxlength="4000"
          aria-labelledby="main-persona-title"
          disabled={!mainLoaded}
          bind:value={mainInstructions}
          oninput={() => (mainStatus = "")}
        ></textarea>
        <div class="row">
          <button type="submit" disabled={!mainLoaded || mainSaving}>保存</button>
          <small>{mainInstructions.length} / 4000</small>
          {#if mainStatus === "saved"}<small role="status">保存しました</small>{/if}
          {#if mainStatus === "failed"}<small role="alert">保存できませんでした</small>{/if}
          {#if mainStatus === "loadFailed"}<small role="alert">読み込めませんでした</small>{/if}
        </div>
      </form>
      {#if error}<p class="banner" role="alert">{error}</p>{/if}

      {#if editingId !== null}
        <form onsubmit={save}>
          <label>名前<input bind:value={name} maxlength="80" required /></label>
          <label>アバター（絵文字や短い名前）<input bind:value={avatar} maxlength="16" required /></label>
          <fieldset class="ai">
            <legend>このペルソナが使うAI</legend>
            <label
              >プロバイダ
              <select bind:value={provider}>
                {#each providers as p (p.id)}
                  <option value={p.id}>{p.label}{p.available ? "" : p.id === "local" ? "（未設定）" : "（APIキー未設定）"}</option>
                {/each}
              </select>
            </label>
            {#if info && !info.available}<p class="hint">{provider === "local" ? "ローカルモデルが未設定です" : "APIキー未設定"}</p>{/if}
            <label
              >モデル
              <input bind:value={model} list="persona-models" maxlength="256" required />
              <datalist id="persona-models">
                {#each info?.suggestedModels ?? [] as m (m)}<option value={m}></option>{/each}
              </datalist>
            {#if provider === "local"}<p class="hint">サーバのローカルモデルを使います（モデル名は表示用）</p>{/if}
            </label>
          </fieldset>
          <label
            >システムプロンプト（このAIの人格・口調）
            <textarea bind:value={systemPrompt} rows="6" maxlength="8000" required></textarea>
            <span class="hint">{systemPrompt.length} / 8000</span>
          </label>
          <div class="row">
            <button type="submit" disabled={!valid || saving}>保存</button>
            <button type="button" onclick={() => (editingId = null)}>キャンセル</button>
          </div>
        </form>
      {/if}

      {#if loaded && personas.length === 0}
        <p class="hint">ペルソナがまだありません。「新規作成」から追加してください。</p>
      {/if}
      <ul>
        {#each personas as p (p.id)}
          <li>
            <span class="avatar" aria-hidden="true">{p.avatar}</span>
            <span class="meta"><strong>{p.name}</strong><small>{personaAiLabel(providers, p)}</small></span>
            <button type="button" onclick={() => openForm(p)}>編集</button>
            <button type="button" class="danger" onclick={() => remove(p)}>削除</button>
          </li>
        {/each}
      </ul>
    </section>
  {/snippet}
</ChatPage>

<style>
  .personas { display: grid; gap: 0.75rem; max-width: 40rem; padding: 1rem; }
  header, .row, li { display: flex; align-items: center; gap: 0.5rem; }
  header { justify-content: space-between; }
  h2, h3 { margin: 0; font-size: 1.1rem; }
  form { display: grid; gap: 0.6rem; padding: 0.75rem; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
  label { display: grid; gap: 0.25rem; font-size: 0.85rem; }
  input, select, textarea, button { font: inherit; color: var(--foreground); background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.35rem 0.6rem; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .danger { color: var(--destructive); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  li { padding: 0.5rem 0.75rem; background: var(--card); border: 1px solid var(--border-subtle); border-radius: var(--radius); }
  .meta { flex: 1; display: grid; min-width: 0; }
  small, .hint { color: var(--muted-foreground); font-size: 0.8rem; margin: 0; }
  fieldset { display: grid; gap: 0.6rem; margin: 0; padding: 0.5rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: var(--radius); }
  legend { padding: 0 0.3rem; font-size: 0.85rem; color: var(--muted-foreground); }
  .avatar { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 50%; background: var(--accent); }
  .banner { margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--destructive); border-radius: var(--radius-sm); color: var(--destructive); }
</style>
