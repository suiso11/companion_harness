<script lang="ts">
import { tick } from "svelte";
import ChatPage from "./ChatPage.svelte";
import { fetchJson, postJson, randomUuid } from "./lib/api.js";
import Markdown from "./lib/Markdown.svelte";
import {
  type ChatMessage,
  type ChatSummary,
  chatTitle,
  deleteJson,
  type Persona,
  type PersonaProviderInfo,
  patchJson,
  previewOf,
  relativeTime,
} from "./lib/persona_chat.js";

const STORAGE_KEY = "ch.personaChatId";

let chats = $state<ChatSummary[]>([]);
let personas = $state<Persona[]>([]);
let providers = $state<PersonaProviderInfo[]>([]);
let loaded = $state(false);
let selectedId = $state<string | null>(null);
let messages = $state<ChatMessage[]>([]);
let pending = $state<string | null>(null); // optimistic user text
let sending = $state(false);
let draft = $state("");
let error = $state("");
let drawer = $state(false);
let pickerId = $state("");
let partnerId = $state("");
let autotalkNew = $state(false);
// Reused while the same text is retried so the server can replay, not re-call.
let retryKey: string | null = $state(null);
let retryText = $state("");
let now = $state(Date.now());
let scroller: HTMLDivElement | undefined = $state();

const selected = $derived(chats.find((c) => c.id === selectedId) ?? null);
const usable = $derived(
  personas.filter(
    (p) => providers.find((x) => x.id === p.provider)?.available === true,
  ),
);

function sortChats(list: ChatSummary[]): ChatSummary[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsert(chat: ChatSummary): void {
  chats = sortChats([chat, ...chats.filter((c) => c.id !== chat.id)]);
}

async function scrollBottom(): Promise<void> {
  await tick();
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

async function select(id: string | null): Promise<void> {
  selectedId = id;
  drawer = false;
  messages = [];
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable: selection just is not remembered
  }
  if (id === null) return;
  const res = await fetchJson(`/api/chats/${id}/messages?limit=50`);
  if (selectedId !== id) return;
  if (res.status !== 200) {
    error = "メッセージを読み込めませんでした";
    return;
  }
  error = "";
  messages = (res.body as { messages: ChatMessage[] }).messages;
  await scrollBottom();
}

async function init(): Promise<void> {
  const [c, p] = await Promise.all([
    fetchJson("/api/chats"),
    fetchJson("/api/personas"),
  ]);
  if (p.status === 200) {
    const body = p.body as {
      personas: Persona[];
      providers: PersonaProviderInfo[];
    };
    personas = body.personas;
    providers = body.providers;
    pickerId = usable[0]?.id ?? "";
  }
  if (c.status !== 200) {
    error = "会話を読み込めませんでした";
    loaded = true;
    return;
  }
  chats = sortChats((c.body as { chats: ChatSummary[] }).chats);
  loaded = true;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  await select(chats.find((x) => x.id === stored)?.id ?? chats[0]?.id ?? null);
}
void init();

async function create(): Promise<void> {
  const personaId = pickerId || usable[0]?.id;
  if (!personaId) return;
  const partner = partnerId !== "" && partnerId !== personaId ? partnerId : "";
  const body: Record<string, unknown> = { personaId };
  if (partner) {
    body.partnerId = partner;
    if (autotalkNew) body.autotalk = true;
  }
  const res = await postJson("/api/chats", body, null);
  if (res.status !== 201) {
    error = "会話を作成できませんでした";
    return;
  }
  const chat = res.body as ChatSummary;
  upsert(chat);
  partnerId = "";
  autotalkNew = false;
  await select(chat.id);
}

async function toggleAutotalk(): Promise<void> {
  if (!selected) return;
  const res = await patchJson(`/api/chats/${selected.id}`, {
    autotalk: !selected.autotalk,
  });
  if (res.status !== 200) {
    error = "自走の設定を変更できませんでした";
    return;
  }
  upsert(res.body as ChatSummary);
}

function speaker(m: ChatMessage): { name: string; avatar: string } {
  const p = m.personaId
    ? personas.find((x) => x.id === m.personaId)
    : undefined;
  return {
    name: p?.name ?? selected?.personaName ?? "",
    avatar: p?.avatar ?? selected?.avatar ?? "",
  };
}

// Autotalk messages arrive server-side; poll while visible, keep scroll if reading history.
async function refresh(id: string): Promise<void> {
  if (sending) return;
  const res = await fetchJson(`/api/chats/${id}/messages?limit=50`);
  if (res.status !== 200 || selectedId !== id || sending) return;
  const body = res.body as { chat?: ChatSummary; messages: ChatMessage[] };
  const atBottom =
    !scroller ||
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  messages = body.messages;
  if (body.chat) upsert(body.chat);
  if (atBottom) await scrollBottom();
}

$effect(() => {
  const id = selectedId;
  if (id === null || !selected?.autotalk) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    if (document.visibilityState === "visible")
      timer = setInterval(() => void refresh(id), 60_000);
  };
  document.addEventListener("visibilitychange", start);
  start();
  return () => {
    document.removeEventListener("visibilitychange", start);
    stop();
  };
});

async function rename(chat: ChatSummary): Promise<void> {
  const title = prompt("会話の名前", chat.title)?.trim();
  if (!title || title === chat.title) return;
  const res = await patchJson(`/api/chats/${chat.id}`, { title });
  if (res.status !== 200) {
    error = "名前を変更できませんでした";
    return;
  }
  upsert(res.body as ChatSummary);
}

async function remove(chat: ChatSummary): Promise<void> {
  if (!confirm("この会話を削除します。よろしいですか？")) return;
  const res = await deleteJson(`/api/chats/${chat.id}`);
  if (res.status !== 200) {
    error = "削除できませんでした";
    return;
  }
  chats = chats.filter((c) => c.id !== chat.id);
  if (selectedId === chat.id) await select(chats[0]?.id ?? null);
}

async function send(): Promise<void> {
  const text = draft.trim();
  const id = selectedId;
  if (!text || id === null || sending) return;
  sending = true;
  pending = text;
  draft = "";
  await scrollBottom();
  const clientKey =
    retryKey !== null && retryText === text ? retryKey : randomUuid();
  const res = await postJson(
    `/api/chats/${id}/messages`,
    { text, clientKey },
    null,
  );
  sending = false;
  pending = null;
  if (res.status !== 200) {
    retryKey = clientKey;
    retryText = text;
    error =
      res.status === 409
        ? "このプロバイダのAPIキーが未設定です"
        : "送信できませんでした";
    if (draft === "") draft = text;
    return;
  }
  retryKey = null;
  retryText = "";
  error = "";
  const body = res.body as {
    chat: ChatSummary;
    messages: { user: ChatMessage; assistant: ChatMessage };
  };
  upsert(body.chat);
  if (selectedId === id) {
    messages = [...messages, body.messages.user, body.messages.assistant];
    await scrollBottom();
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
</script>

<svelte:head>
  <title>ペルソナとの会話 · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/chats" chatSurface={false}>
  {#snippet children()}
    <div class="chats">
      <aside class:open={drawer} aria-label="会話一覧">
        <div class="new">
          <select bind:value={pickerId} disabled={usable.length === 0} aria-label="ペルソナを選択">
            {#each usable as p (p.id)}<option value={p.id}>{p.avatar} {p.name}</option>{/each}
          </select>
          <button type="button" disabled={usable.length === 0} onclick={create}>新しい会話</button>
        </div>
        <div class="new opts">
          <select bind:value={partnerId} disabled={usable.length < 2} aria-label="相手（省略可）">
            <option value="">相手（省略可）</option>
            {#each usable.filter((p) => p.id !== pickerId) as p (p.id)}<option value={p.id}>{p.avatar} {p.name}</option>{/each}
          </select>
          <label><input type="checkbox" bind:checked={autotalkNew} disabled={partnerId === "" || partnerId === pickerId} /> 自走で話す（1時間おき）</label>
        </div>
        {#if loaded && personas.length === 0}
          <p class="hint">ペルソナがありません。<a href="/personas">ペルソナを作成</a></p>
        {:else if loaded && usable.length === 0}
          <p class="hint">APIキーが設定されたプロバイダのペルソナがありません。</p>
        {/if}
        {#if loaded && chats.length === 0}
          <p class="hint">会話はまだありません。「新しい会話」で始めましょう。</p>
        {/if}
        <ul>
          {#each chats as chat (chat.id)}
            <li class:active={chat.id === selectedId}>
              <button type="button" class="row" onclick={() => select(chat.id)}>
                <span class="avatar" aria-hidden="true">{chat.avatar}</span>
                {#if chat.partnerAvatar}<span class="avatar partner" aria-hidden="true">{chat.partnerAvatar}</span>{/if}
                <span class="body">
                  <span class="top"><strong>{chatTitle(chat)}</strong><small>{relativeTime(now, chat.updatedAt)}</small></span>
                  <span class="title">{chat.title}{#if chat.autotalk} <span class="badge">自走</span>{/if}</span>
                  <small class="preview">{previewOf(chat.preview)}</small>
                </span>
              </button>
              <span class="actions">
                <button type="button" aria-label="名前を変更" onclick={() => rename(chat)}>✎</button>
                <button type="button" aria-label="削除" onclick={() => remove(chat)}>🗑</button>
              </span>
            </li>
          {/each}
        </ul>
      </aside>

      <section class="pane">
        <header>
          <button type="button" class="toggle" aria-label="会話一覧を開く" aria-expanded={drawer} onclick={() => { drawer = !drawer; now = Date.now(); }}>☰</button>
          <span class="who"><strong>{selected ? `${chatTitle(selected)} · ${selected.title}` : "ペルソナとの会話"}</strong>{#if selected?.autotalk}<small>1時間おきに自動で話します</small>{/if}</span>
          {#if selected?.partnerId}
            <button type="button" aria-pressed={selected.autotalk} onclick={toggleAutotalk}>自走 {selected.autotalk ? "ON" : "OFF"}</button>
          {/if}
        </header>
        {#if error}<p class="banner" role="alert">{error}</p>{/if}
        {#if selected}
          <div class="scroll" bind:this={scroller}>
            {#each messages as m, i (m.id)}
              {@const who = speaker(m)}
              {#if m.role === "assistant" && (i === 0 || messages[i - 1]?.role !== "assistant" || messages[i - 1]?.personaId !== m.personaId)}
                <p class="name">{who.name}</p>
              {/if}
              <div class="msg {m.role}">
                {#if m.role === "assistant"}<span class="avatar" aria-hidden="true">{who.avatar}</span>{/if}
                <div class="bubble"
                  >{#if m.role === "assistant"}<Markdown text={m.content} />{:else}{m.content}{/if}</div
                >
              </div>
            {/each}
            {#if pending !== null}
              <div class="msg user"><div class="bubble">{pending}</div></div>
            {/if}
            {#if sending}
              <div class="msg assistant">
                <span class="avatar" aria-hidden="true">{selected.avatar}</span>
                <div class="bubble typing">入力中…</div>
              </div>
            {/if}
          </div>
          <form class="composer" onsubmit={(e) => { e.preventDefault(); void send(); }}>
            <textarea bind:value={draft} rows="2" maxlength="8000" aria-label="メッセージ" placeholder="メッセージを入力（Shift+Enterで改行）" onkeydown={onKey}></textarea>
            <button type="submit" disabled={sending || draft.trim() === ""}>送信</button>
          </form>
        {:else if loaded}
          <p class="hint empty">会話を選択するか、新しい会話を始めてください。</p>
        {/if}
      </section>
    </div>
  {/snippet}
</ChatPage>

<style>
  .chats { display: flex; height: 100%; min-height: 24rem; border: 1px solid var(--border-subtle); border-radius: var(--radius); overflow: hidden; background: var(--background); position: relative; }
  aside { width: 20rem; flex: none; display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; background: var(--card); border-right: 1px solid var(--border-subtle); overflow-y: auto; }
  .new { display: flex; gap: 0.4rem; }
  .new select { flex: 1; min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
  li { display: flex; align-items: center; border-radius: var(--radius-sm); }
  li.active { background: var(--accent); }
  li:hover .actions, li:focus-within .actions { visibility: visible; }
  .actions { visibility: hidden; display: flex; }
  .row { flex: 1; min-width: 0; display: flex; gap: 0.5rem; text-align: left; background: none; border: 0; }
  .body { flex: 1; min-width: 0; display: grid; }
  .top { display: flex; justify-content: space-between; gap: 0.5rem; }
  .title, .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview, small, .hint { color: var(--muted-foreground); font-size: 0.8rem; margin: 0; }
  button, select, textarea { font: inherit; color: var(--foreground); background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.3rem 0.6rem; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions button { background: none; border: 0; padding: 0.2rem; }
  .avatar { flex: none; display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: var(--secondary); }
  .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border-subtle); }
  .toggle { display: none; }
  .scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.6rem; padding: 0.75rem; }
  .msg { display: flex; gap: 0.5rem; align-items: flex-end; }
  .msg.user { justify-content: flex-end; }
  .bubble { max-width: 70%; padding: 0.5rem 0.75rem; border-radius: var(--radius-lg); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--card); }
  .user .bubble { background: var(--secondary); }
  .typing { color: var(--muted-foreground); }
  .composer { display: flex; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid var(--border-subtle); }
  .composer textarea { flex: 1; resize: none; }
  .banner { margin: 0.5rem; padding: 0.5rem 0.75rem; border: 1px solid var(--destructive); border-radius: var(--radius-sm); color: var(--destructive); }
  .empty { padding: 1rem; }
  @media (max-width: 720px) {
    .toggle { display: inline-block; }
    aside { position: absolute; inset: 0 auto 0 0; z-index: 2; width: min(20rem, 85%); transform: translateX(-100%); transition: transform 0.15s; }
    aside.open { transform: none; }
    .actions { visibility: visible; }
    .bubble { max-width: 85%; }
  }
  .partner { margin-left: -0.6rem; }
  .badge { font-size: 0.7rem; padding: 0 0.4rem; border-radius: var(--radius-sm); background: var(--secondary); }
  .name { color: var(--muted-foreground); font-size: 0.75rem; margin: 0 0 0.15rem 2.5rem; }
  .who { display: grid; }
  .opts { flex-direction: column; }
</style>
