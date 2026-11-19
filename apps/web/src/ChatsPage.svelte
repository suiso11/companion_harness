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
import {
  pairAiLabel,
  personaAiLabel,
  providerLabel,
} from "./lib/persona_display.js";
import {
  BALANCE_SVG_WIDTH,
  buildDialogueStage,
  buildPersonaConstellation,
  classifyMessageSlot,
  MAIN_PARTNER_ID,
  type SpeakerSlot,
  type TurnTimelineBar,
} from "./lib/persona_visualizer.js";

const STORAGE_KEY = "ch.personaChatId";
// partnerId sentinel: the real main agent instead of a persona.
const MAIN_PARTNER = MAIN_PARTNER_ID;
const MAIN_NAME = "メインAI";
const MAIN_AVATAR = "🜲";

let chats = $state<ChatSummary[]>([]);
let personas = $state<Persona[]>([]);
let providers = $state<PersonaProviderInfo[]>([]);
let mainAvailable = $state(false);
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

// Visualizer state: constellation studio toggle, turn scrubber hover, speaker filter.
let studioOpen = $state(false);
let hoveredTurn = $state<TurnTimelineBar | null>(null);
let highlightedMsgId = $state<string | null>(null);
let speakerFilter = $state<"all" | SpeakerSlot>("all");

const selected = $derived(chats.find((c) => c.id === selectedId) ?? null);
const usable = $derived(
  personas.filter(
    (p) => providers.find((x) => x.id === p.provider)?.available === true,
  ),
);

const constellation = $derived(
  buildPersonaConstellation({
    personas,
    chats,
    providers,
    mainAvailable,
    pickerId,
    partnerId,
    selectedChatId: selectedId,
  }),
);

const dialogueStage = $derived(
  selected === null
    ? null
    : buildDialogueStage({
        chat: selected,
        messages,
        personas,
        providers,
        sending,
      }),
);

const selectedPrimaryNode = $derived(
  constellation.nodes.find((n) => n.id === pickerId) ?? null,
);
const selectedPartnerNode = $derived(
  partnerId === ""
    ? null
    : (constellation.nodes.find((n) => n.id === partnerId) ?? null),
);

function clickConstellationNode(id: string, available: boolean): void {
  if (!available) return;
  if (id === MAIN_PARTNER) {
    // Main AI can only be the partner slot.
    partnerId = partnerId === MAIN_PARTNER ? "" : MAIN_PARTNER;
    if (partnerId === "") autotalkNew = false;
    return;
  }
  if (pickerId === "" || pickerId === id) {
    pickerId = id;
    if (partnerId === id) {
      partnerId = "";
      autotalkNew = false;
    }
    return;
  }
  if (partnerId === id) {
    // Clicking the current partner promotes it to primary or clears partner.
    partnerId = "";
    autotalkNew = false;
    return;
  }
  partnerId = id;
}

function scrollToMessage(msgId: string): void {
  highlightedMsgId = msgId;
  const el = document.getElementById(`persona-msg-${msgId}`);
  if (el !== null) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

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
  hoveredTurn = null;
  highlightedMsgId = null;
  speakerFilter = "all";
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
      mainAvailable: boolean;
    };
    personas = body.personas;
    providers = body.providers;
    mainAvailable = body.mainAvailable;
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
  const body: Record<string, unknown> = { personaId };
  if (partnerId === MAIN_PARTNER) {
    body.partnerMain = true;
    body.autotalk = autotalkNew;
  } else if (partnerId !== "" && partnerId !== personaId) {
    body.partnerId = partnerId;
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
  studioOpen = false;
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
  if (m.role === "assistant" && m.personaId === null && selected?.partnerMain)
    return { name: MAIN_NAME, avatar: MAIN_AVATAR };
  const p = m.personaId
    ? personas.find((x) => x.id === m.personaId)
    : undefined;
  return {
    name: p?.name ?? selected?.personaName ?? "",
    avatar: p?.avatar ?? selected?.avatar ?? "",
  };
}

function titleOf(chat: ChatSummary): string {
  return chatTitle({
    personaName: chat.personaName,
    partnerName: chat.partnerMain ? MAIN_NAME : chat.partnerName,
  });
}

function aiLabelOf(chat: ChatSummary): string {
  if (chat.partnerMain)
    return `${providerLabel(providers, chat.provider)} × ${MAIN_NAME}`;
  const partner = personas.find((p) => p.id === chat.partnerId);
  return pairAiLabel(providers, chat.provider, partner?.provider ?? null);
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
        {#if usable.length > 0}
          <div class="palette" data-persona-palette="true" aria-label="直感ペア選択">
            <div class="palette-head">
              <small>タップで主役・相手を選択</small>
              {#if partnerId !== ""}
                <button
                  type="button"
                  class="palette-clear"
                  onclick={() => {
                    partnerId = "";
                    autotalkNew = false;
                  }}
                >
                  1対1に戻す
                </button>
              {/if}
            </div>
            <div class="palette-chips">
              {#each usable as p (p.id)}
                {@const role =
                  pickerId === p.id
                    ? "primary"
                    : partnerId === p.id
                      ? "partner"
                      : "idle"}
                <button
                  type="button"
                  class="palette-chip"
                  data-role={role}
                  title={`${p.name}（${personaAiLabel(providers, p)}）`}
                  onclick={() => clickConstellationNode(p.id, true)}
                >
                  <span class="palette-avatar">{p.avatar}</span>
                  <span class="palette-name">{p.name}</span>
                  {#if role === "primary"}
                    <span class="palette-tag">主役</span>
                  {:else if role === "partner"}
                    <span class="palette-tag">相手</span>
                  {/if}
                </button>
              {/each}
              {#if mainAvailable}
                <button
                  type="button"
                  class="palette-chip"
                  data-role={partnerId === MAIN_PARTNER ? "partner" : "idle"}
                  title="メインAI（本物のエージェント）を相手にする"
                  onclick={() => clickConstellationNode(MAIN_PARTNER, true)}
                >
                  <span class="palette-avatar">{MAIN_AVATAR}</span>
                  <span class="palette-name">{MAIN_NAME}</span>
                  {#if partnerId === MAIN_PARTNER}
                    <span class="palette-tag">相手</span>
                  {/if}
                </button>
              {/if}
            </div>
          </div>
        {/if}

        <div class="new">
          <select bind:value={pickerId} disabled={usable.length === 0} aria-label="ペルソナを選択">
            {#each usable as p (p.id)}<option value={p.id}>{p.avatar} {p.name}（{personaAiLabel(providers, p)}）</option>{/each}
          </select>
          <button type="button" disabled={usable.length === 0} onclick={create}>新しい会話</button>
        </div>
        <div class="new opts">
          <select bind:value={partnerId} disabled={usable.length < 2 && !mainAvailable} aria-label="相手（省略可）">
            <option value="">相手（省略可）</option>
            {#if mainAvailable}<option value={MAIN_PARTNER}>メインAI（本物）</option>{/if}
            {#each usable.filter((p) => p.id !== pickerId) as p (p.id)}<option value={p.id}>{p.avatar} {p.name}（{personaAiLabel(providers, p)}）</option>{/each}
          </select>
          <label><input type="checkbox" bind:checked={autotalkNew} disabled={partnerId === "" || partnerId === pickerId} /> 自走で話す（1時間おき）</label>
          {#if partnerId === MAIN_PARTNER}<p class="hint">メインAIは本物のエージェント（ツール・記憶あり）が、1時間ごとの自走のタイミングで返信します。</p>{/if}
        </div>
        {#if loaded && personas.length === 0}
          <p class="hint">ペルソナがありません。<a href="/personas">ペルソナを作成</a></p>
        {:else if loaded && usable.length === 0}
          <p class="hint">APIキーが設定されたプロバイダのペルソナがありません。{#if personas.some((p) => p.provider !== "local")}<a href="/settings">APIキーを設定</a>{/if}</p>
        {/if}
        {#if loaded && chats.length === 0}
          <p class="hint">会話はまだありません。「新しい会話」で始めましょう。</p>
        {/if}
        <ul>
          {#each chats as chat (chat.id)}
            <li class:active={chat.id === selectedId}>
              <button type="button" class="row" onclick={() => select(chat.id)}>
                <span class="avatar" aria-hidden="true">{chat.avatar}</span>
                {#if chat.partnerAvatar}<span class="avatar partner" aria-hidden="true">{chat.partnerAvatar}</span>{:else if chat.partnerMain}<span class="avatar partner" aria-hidden="true">{MAIN_AVATAR}</span>{/if}
                <span class="body">
                  <span class="top"><span><strong>{titleOf(chat)}</strong> <small>{aiLabelOf(chat)}</small></span><small>{relativeTime(now, chat.updatedAt)}</small></span>
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
          <span class="who"><strong>{selected ? `${titleOf(selected)} · ${selected.title}` : "ペルソナとの会話"}</strong>{#if selected}<small>{aiLabelOf(selected)}</small>{/if}{#if selected?.autotalk}<small>1時間おきに自動で話します</small>{/if}</span>
          <div class="header-controls">
            <button
              type="button"
              class="studio-btn"
              aria-pressed={studioOpen || selected === null}
              data-studio-toggle="true"
              onclick={() => (studioOpen = !studioOpen)}
            >
              ✦ 相関スタジオ
            </button>
            {#if selected?.partnerId || selected?.partnerMain}
              <button type="button" aria-pressed={selected.autotalk} onclick={toggleAutotalk}>自走 {selected.autotalk ? "ON" : "OFF"}</button>
            {/if}
          </div>
        </header>
        {#if error}<p class="banner" role="alert">{error}</p>{/if}

        {#if (studioOpen || selected === null) && loaded && personas.length > 0}
          <section
            id="persona-constellation"
            class="constellation-studio"
            data-persona-constellation="true"
            aria-label="ペルソナ相関マップ＆ペアリングスタジオ"
          >
            <div class="constellation-head">
              <div>
                <strong>ペルソナ相関＆ペアリング・ビジュアライザ</strong>
                <small>ノードをクリックして「主役 × 相手」を直感的に組み合わせ、接続線をクリックして会話を切り替えます</small>
              </div>
              {#if selected !== null}
                <button type="button" onclick={() => (studioOpen = false)}>閉じる</button>
              {/if}
            </div>

            <div class="constellation-canvas-wrap">
              <svg
                class="constellation-svg"
                viewBox={`0 0 ${constellation.width} ${constellation.height}`}
                shape-rendering="crispEdges"
                role="img"
                aria-label="ペルソナ相関図"
              >
                <rect
                  class="constellation-orbit"
                  x="96"
                  y="40"
                  width="448"
                  height="172"
                />

                {#each constellation.edges as edge (edge.id)}
                  <g
                    class="constellation-edge-group"
                    data-active={edge.active}
                    data-autotalk={edge.autotalk}
                    role="button"
                    tabindex="0"
                    aria-label={`既存の会話を開く: ${edge.title}`}
                    onclick={() => {
                      studioOpen = false;
                      void select(edge.chatId);
                    }}
                    onkeydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        studioOpen = false;
                        void select(edge.chatId);
                      }
                    }}
                  >
                    <path
                      class="constellation-edge"
                      d={edge.path}
                      stroke-width={edge.strokeWidth}
                    />
                    <rect
                      class="constellation-edge-pill"
                      x={edge.labelX - 28}
                      y={edge.labelY - 10}
                      width="56"
                      height="20"
                    />
                    <text
                      class="constellation-edge-text"
                      x={edge.labelX}
                      y={edge.labelY + 4}
                      text-anchor="middle"
                    >
                      {edge.autotalk ? "⚡" : "💬"}{edge.messageCount}
                    </text>
                  </g>
                {/each}

                {#if constellation.pairingBeam !== null && constellation.pairingBeam.toId !== ""}
                  <line
                    class="constellation-beam"
                    x1={constellation.pairingBeam.x1}
                    y1={constellation.pairingBeam.y1}
                    x2={constellation.pairingBeam.x2}
                    y2={constellation.pairingBeam.y2}
                  />
                {/if}

                {#each constellation.nodes as node (node.id)}
                  <g
                    class="constellation-node"
                    data-role={node.role}
                    data-available={node.available}
                    data-main={node.isMain}
                    transform={`translate(${node.x}, ${node.y})`}
                    role="button"
                    tabindex={node.available ? 0 : undefined}
                    aria-label={`ペルソナノード: ${node.name}`}
                    onclick={() => clickConstellationNode(node.id, node.available)}
                    onkeydown={(e) => {
                      if (node.available && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        clickConstellationNode(node.id, node.available);
                      }
                    }}
                  >
                    {#if node.role === "primary" || node.role === "partner"}
                      <rect
                        class="constellation-node-halo"
                        x={-node.r - 5}
                        y={-node.r - 5}
                        width={(node.r + 5) * 2}
                        height={(node.r + 5) * 2}
                      />
                    {/if}
                    <rect
                      class="constellation-node-disc"
                      x={-node.r}
                      y={-node.r}
                      width={node.r * 2}
                      height={node.r * 2}
                    />
                    <text class="constellation-node-avatar" x="0" y="6" text-anchor="middle">
                      {node.avatar}
                    </text>
                    <text
                      class="constellation-node-name"
                      x="0"
                      y={node.r + 15}
                      text-anchor="middle"
                    >
                      {node.shortName}
                    </text>
                    <text
                      class="constellation-node-ai"
                      x="0"
                      y={node.r + 27}
                      text-anchor="middle"
                    >
                      {node.aiLabel}
                    </text>
                    {#if node.role === "primary" || node.role === "partner"}
                      <g>
                        <rect
                          class="constellation-node-role-bg"
                          x="-18"
                          y={-node.r - 17}
                          width="36"
                          height="15"
                        />
                        <text
                          class="constellation-node-role"
                          x="0"
                          y={-node.r - 6}
                          text-anchor="middle"
                        >
                          {node.role === "primary" ? "主役" : "相手"}
                        </text>
                      </g>
                    {/if}
                  </g>
                {/each}
              </svg>
            </div>

            <div class="constellation-dock" data-pairing-dock="true">
              <div class="constellation-pair-preview">
                <span class="pair-slot" data-slot="primary">
                  <span class="avatar" aria-hidden="true">{selectedPrimaryNode?.avatar ?? "—"}</span>
                  <span>
                    <small>主役</small>
                    <strong>{selectedPrimaryNode?.name ?? "未選択"}</strong>
                  </span>
                </span>
                <span class="pair-bridge">⇄</span>
                <span class="pair-slot" data-slot="partner">
                  <span class="avatar" aria-hidden="true">{selectedPartnerNode?.avatar ?? "🧑"}</span>
                  <span>
                    <small>相手</small>
                    <strong>{selectedPartnerNode ? selectedPartnerNode.name : "あなた（1対1）"}</strong>
                  </span>
                </span>
              </div>

              <div class="constellation-actions">
                {#if partnerId !== ""}
                  <button
                    type="button"
                    aria-pressed={autotalkNew}
                    onclick={() => (autotalkNew = !autotalkNew)}
                  >
                    ⚡ 自走 {autotalkNew ? "ON" : "OFF"}
                  </button>
                {/if}
                {#if constellation.pairingBeam?.existingChatId}
                  {@const existingId = constellation.pairingBeam.existingChatId}
                  <button
                    type="button"
                    onclick={() => {
                      studioOpen = false;
                      void select(existingId);
                    }}
                  >
                    💬 既存の会話を開く
                  </button>
                {/if}
                <button
                  type="button"
                  class="primary-btn"
                  disabled={usable.length === 0}
                  onclick={create}
                >
                  ＋ この組み合わせで新規会話
                </button>
              </div>
            </div>
          </section>
        {/if}

        {#if selected && dialogueStage !== null}
          <section
            id="persona-dialogue-stage"
            class="dialogue-stage"
            data-dialogue-stage="true"
            aria-label="対話ステージとターンタイムライン"
          >
            <div class="stage-actors">
              <div
                class="stage-actor"
                data-slot="primary"
                data-active={dialogueStage.primary.isLastSpeaker || dialogueStage.primary.isGenerating}
              >
                <span class="stage-avatar" aria-hidden="true">{dialogueStage.primary.avatar}</span>
                <div class="stage-actor-meta">
                  <strong>{dialogueStage.primary.name}</strong>
                  <small>{dialogueStage.primary.aiLabel}</small>
                  <small class="stage-stat">
                    {dialogueStage.primary.turnCount}発言（{dialogueStage.primary.sharePct}%）
                  </small>
                </div>
              </div>

              <div class="stage-bridge">
                <svg
                  class="stage-wave-svg"
                  viewBox="0 0 160 28"
                  shape-rendering="crispEdges"
                  aria-hidden="true"
                >
                  <line class="stage-wave-track" x1="8" y1="14" x2="152" y2="14" />
                  {#if sending || selected.autotalk}
                    <path
                      class="stage-wave-active"
                      d="M 8 14 H 24 V 5 H 40 V 23 H 56 V 9 H 72 V 19 H 88 V 5 H 104 V 23 H 120 V 9 H 136 V 14 H 152"
                    />
                  {/if}
                  <rect class="stage-wave-node" x="76" y="10" width="8" height="8" />
                </svg>
                <svg
                  class="stage-balance-svg"
                  viewBox={`0 0 ${BALANCE_SVG_WIDTH} 6`}
                  preserveAspectRatio="none"
                  shape-rendering="crispEdges"
                  aria-label="発言バランス"
                >
                  <rect
                    class="stage-balance-track"
                    x="0"
                    y="0"
                    width={BALANCE_SVG_WIDTH}
                    height="6"
                  />
                  {#each dialogueStage.balanceSegments as seg (seg.slot)}
                    <rect
                      class="stage-balance-seg"
                      data-slot={seg.slot}
                      x={seg.x}
                      y="0"
                      width={seg.width}
                      height="6"
                    />
                  {/each}
                </svg>
                <small class="stage-turn-count">
                  全 {dialogueStage.totalTurns} ターン{selected.autotalk ? " · ⚡自走中" : ""}
                </small>
              </div>

              <div
                class="stage-actor stage-actor-right"
                data-slot={dialogueStage.secondary.slot}
                data-active={dialogueStage.secondary.isLastSpeaker}
              >
                <div class="stage-actor-meta">
                  <strong>{dialogueStage.secondary.name}</strong>
                  <small>{dialogueStage.secondary.aiLabel}</small>
                  <small class="stage-stat">
                    {dialogueStage.secondary.turnCount}発言（{dialogueStage.secondary.sharePct}%）
                  </small>
                </div>
                <span class="stage-avatar" aria-hidden="true">{dialogueStage.secondary.avatar}</span>
              </div>
            </div>

            {#if dialogueStage.turnBars.length > 0}
              <div class="turn-scrubber" data-turn-timeline="true">
                <div class="turn-scrubber-head">
                  <div class="turn-filters" role="group" aria-label="話者フィルタ">
                    <button
                      type="button"
                      class="turn-filter-chip"
                      aria-pressed={speakerFilter === "all"}
                      onclick={() => (speakerFilter = "all")}
                    >
                      すべて ({dialogueStage.totalTurns})
                    </button>
                    <button
                      type="button"
                      class="turn-filter-chip"
                      data-slot="primary"
                      aria-pressed={speakerFilter === "primary"}
                      onclick={() =>
                        (speakerFilter =
                          speakerFilter === "primary" ? "all" : "primary")}
                    >
                      {dialogueStage.primary.avatar} {dialogueStage.primary.name} ({dialogueStage.primary.turnCount})
                    </button>
                    <button
                      type="button"
                      class="turn-filter-chip"
                      data-slot={dialogueStage.secondary.slot}
                      aria-pressed={speakerFilter === dialogueStage.secondary.slot}
                      onclick={() =>
                        (speakerFilter =
                          speakerFilter === dialogueStage.secondary.slot
                            ? "all"
                            : dialogueStage.secondary.slot)}
                    >
                      {dialogueStage.secondary.avatar} {dialogueStage.secondary.name} ({dialogueStage.secondary.turnCount})
                    </button>
                  </div>
                  <small class="turn-preview">
                    {#if hoveredTurn !== null}
                      #{hoveredTurn.index} {hoveredTurn.speakerAvatar} {hoveredTurn.speakerName}: {hoveredTurn.preview}
                    {:else}
                      バーをクリックすると該当ターンへジャンプします
                    {/if}
                  </small>
                </div>

                <svg
                  class="turn-timeline-svg"
                  viewBox={`0 0 ${dialogueStage.timelineWidth} ${dialogueStage.timelineHeight}`}
                  preserveAspectRatio="none"
                  shape-rendering="crispEdges"
                  role="group"
                  aria-label="会話ターン・ミニマップ"
                >
                  {#each dialogueStage.turnBars as bar (bar.id)}
                    <rect
                      class="turn-bar"
                      data-slot={bar.slot}
                      data-selected={highlightedMsgId === bar.id}
                      data-dimmed={speakerFilter !== "all" && speakerFilter !== bar.slot}
                      x={bar.x}
                      y={bar.y}
                      width={bar.width}
                      height={bar.height}
                      role="button"
                      tabindex="0"
                      aria-label={`ターン #${bar.index} ${bar.speakerName}: ${bar.preview}`}
                      onmouseenter={() => (hoveredTurn = bar)}
                      onfocus={() => (hoveredTurn = bar)}
                      onmouseleave={() => {
                        if (hoveredTurn?.id === bar.id) hoveredTurn = null;
                      }}
                      onclick={() => scrollToMessage(bar.id)}
                      onkeydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          scrollToMessage(bar.id);
                        }
                      }}
                    />
                  {/each}
                </svg>
              </div>
            {/if}
          </section>

          <div class="scroll" bind:this={scroller}>
            {#each messages as m, i (m.id)}
              {@const who = speaker(m)}
              {@const slot = classifyMessageSlot(m, selected)}
              {#if m.role === "assistant" && (i === 0 || messages[i - 1]?.role !== "assistant" || messages[i - 1]?.personaId !== m.personaId)}
                <p class="name">{who.name}</p>
              {/if}
              <div
                id={`persona-msg-${m.id}`}
                class="msg {m.role}"
                data-slot={slot}
                data-highlighted={highlightedMsgId === m.id}
                data-dimmed={speakerFilter !== "all" && speakerFilter !== slot}
              >
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
  .avatar { flex: none; display: grid; place-items: center; width: 2rem; height: 2rem; border: 2px solid var(--border); background: var(--secondary); box-shadow: var(--shadow-sm); }
  .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 2px solid var(--border-subtle); }
  .header-controls { display: flex; align-items: center; gap: 0.4rem; }
  .studio-btn[aria-pressed="true"], .primary-btn { border-color: var(--ring); background: var(--accent); color: var(--accent-foreground); font-weight: 600; }
  .toggle { display: none; }
  .scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.6rem; padding: 0.75rem; }
  .msg { display: flex; gap: 0.5rem; align-items: flex-end; transition: opacity 0.15s; }
  .msg.user { justify-content: flex-end; }
  .msg[data-dimmed="true"] { opacity: 0.28; }
  .msg[data-highlighted="true"] .bubble { outline: 2px solid var(--ring); outline-offset: 2px; }
  .msg[data-slot="partner"] .bubble { border-left: 4px solid var(--chart-2); }
  .msg[data-slot="primary"] .bubble { border-left: 4px solid var(--chart-1); }
  .bubble { max-width: 70%; padding: 0.5rem 0.75rem; border: 2px solid var(--border-subtle); box-shadow: var(--shadow-sm); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--card); }
  .user .bubble { background: var(--secondary); }
  .typing { color: var(--muted-foreground); }
  .composer { display: flex; gap: 0.5rem; padding: 0.5rem; border-top: 2px solid var(--border-subtle); }
  .composer textarea { flex: 1; resize: none; }
  .banner { margin: 0.5rem; padding: 0.5rem 0.75rem; border: 2px solid var(--destructive); color: var(--destructive); }
  .empty { padding: 1rem; }
  .partner { margin-left: -0.4rem; }
  .badge { font-size: 0.7rem; padding: 0 0.4rem; border: 1px solid var(--border); background: var(--secondary); }
  .name { color: var(--muted-foreground); font-size: 0.75rem; margin: 0 0 0.15rem 2.5rem; font-family: var(--font-mono); }
  .who { flex: 1; min-width: 0; display: grid; }
  .opts { flex-direction: column; }

  /* Sidebar visual persona palette */
  .palette { display: grid; gap: 0.35rem; padding: 0.45rem; border: 2px solid var(--border-subtle); background: var(--background); }
  .palette-head { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
  .palette-clear { font-size: 0.7rem; padding: 0.1rem 0.4rem; }
  .palette-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .palette-chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.45rem; font-size: 0.78rem; background: var(--card); border: 2px solid var(--border-subtle); box-shadow: var(--shadow-sm); }
  .palette-chip[data-role="primary"] { border-color: var(--chart-1); background: color-mix(in oklab, var(--chart-1) 18%, var(--card)); }
  .palette-chip[data-role="partner"] { border-color: var(--chart-2); background: color-mix(in oklab, var(--chart-2) 18%, var(--card)); }
  .palette-tag { font-size: 0.65rem; padding: 0 0.3rem; background: var(--secondary); font-family: var(--font-mono); }

  /* Constellation Studio */
  .constellation-studio { display: grid; gap: 0.6rem; padding: 0.75rem; border-bottom: 2px solid var(--border-subtle); background: color-mix(in oklab, var(--card) 75%, var(--background)); }
  .constellation-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
  .constellation-head div { display: grid; gap: 0.15rem; }
  .constellation-canvas-wrap { border: 2px solid var(--border-subtle); background: var(--background); overflow: hidden; box-shadow: var(--shadow-sm); }
  .constellation-svg { display: block; width: 100%; height: auto; max-height: 15.5rem; }
  .constellation-orbit { fill: none; stroke: var(--border-subtle); stroke-dasharray: 4 4; }
  .constellation-edge-group { cursor: pointer; }
  .constellation-edge { fill: none; stroke: var(--muted-foreground); stroke-opacity: 0.65; }
  .constellation-edge-group[data-autotalk="true"] .constellation-edge { stroke: var(--chart-3); stroke-dasharray: 6 4; stroke-opacity: 0.9; }
  .constellation-edge-group[data-active="true"] .constellation-edge, .constellation-edge-group:hover .constellation-edge { stroke: var(--chart-1); stroke-opacity: 1; }
  .constellation-edge-pill { fill: var(--card); stroke: var(--border); stroke-width: 2; }
  .constellation-edge-text { fill: var(--foreground); font-size: 10px; font-family: var(--font-mono); }
  .constellation-beam { stroke: var(--ring); stroke-width: 2; stroke-dasharray: 4 4; }
  .constellation-node { cursor: pointer; }
  .constellation-node[data-available="false"] { opacity: 0.45; cursor: not-allowed; }
  .constellation-node-halo { fill: none; stroke: var(--chart-1); stroke-width: 2; stroke-dasharray: 4 2; }
  .constellation-node[data-role="partner"] .constellation-node-halo { stroke: var(--chart-2); }
  .constellation-node-disc { fill: var(--card); stroke: var(--border); stroke-width: 2; }
  .constellation-node[data-role="primary"] .constellation-node-disc { stroke: var(--chart-1); stroke-width: 3; }
  .constellation-node[data-role="partner"] .constellation-node-disc { stroke: var(--chart-2); stroke-width: 3; }
  .constellation-node-avatar { font-size: 18px; }
  .constellation-node-name { fill: var(--foreground); font-size: 11px; font-weight: 700; font-family: var(--font-mono); }
  .constellation-node-ai { fill: var(--muted-foreground); font-size: 9px; font-family: var(--font-mono); }
  .constellation-node-role-bg { fill: var(--chart-1); }
  .constellation-node[data-role="partner"] .constellation-node-role-bg { fill: var(--chart-2); }
  .constellation-node-role { fill: var(--background); font-size: 9px; font-weight: 700; font-family: var(--font-mono); }
  .constellation-dock { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0.65rem; border: 2px solid var(--border-subtle); background: var(--card); box-shadow: var(--shadow-sm); }
  .constellation-pair-preview { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .pair-slot { display: inline-flex; align-items: center; gap: 0.4rem; }
  .pair-slot span { display: grid; line-height: 1.2; }
  .pair-bridge { color: var(--muted-foreground); font-weight: 700; font-family: var(--font-mono); }
  .constellation-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }

  /* Live Dialogue Stage & Turn Scrubber */
  .dialogue-stage { display: grid; gap: 0.5rem; padding: 0.55rem 0.75rem; border-bottom: 2px solid var(--border-subtle); background: color-mix(in oklab, var(--card) 60%, var(--background)); }
  .stage-actors { display: grid; grid-template-columns: minmax(0, 1fr) minmax(7rem, 11rem) minmax(0, 1fr); align-items: center; gap: 0.5rem; }
  .stage-actor { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.55rem; border: 2px solid var(--border-subtle); background: var(--card); box-shadow: var(--shadow-sm); min-width: 0; }
  .stage-actor[data-slot="primary"][data-active="true"] { border-color: var(--chart-1); box-shadow: inset 4px 0 0 var(--chart-1), var(--shadow-sm); }
  .stage-actor[data-slot="partner"][data-active="true"] { border-color: var(--chart-2); box-shadow: inset -4px 0 0 var(--chart-2), var(--shadow-sm); }
  .stage-actor-right { justify-content: flex-end; text-align: right; }
  .stage-avatar { flex: none; display: grid; place-items: center; width: 2.2rem; height: 2.2rem; border: 2px solid var(--border); background: var(--secondary); font-size: 1.1rem; }
  .stage-actor-meta { display: grid; min-width: 0; }
  .stage-actor-meta strong, .stage-actor-meta small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage-bridge { display: grid; justify-items: center; gap: 0.2rem; }
  .stage-wave-svg { width: 100%; height: 1.4rem; }
  .stage-wave-track { stroke: var(--border); stroke-width: 2; stroke-dasharray: 4 2; }
  .stage-wave-active { fill: none; stroke: var(--chart-3); stroke-width: 2; }
  .stage-wave-node { fill: var(--ring); }
  .stage-balance-svg { width: 100%; height: 6px; border: 1px solid var(--border-subtle); }
  .stage-balance-track { fill: var(--secondary); }
  .stage-balance-seg[data-slot="primary"] { fill: var(--chart-1); }
  .stage-balance-seg[data-slot="partner"] { fill: var(--chart-2); }
  .stage-balance-seg[data-slot="user"] { fill: var(--chart-3); }
  .turn-scrubber { display: grid; gap: 0.3rem; }
  .turn-scrubber-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem; }
  .turn-filters { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .turn-filter-chip { font-size: 0.72rem; padding: 0.15rem 0.45rem; }
  .turn-filter-chip[aria-pressed="true"] { border-color: var(--ring); background: var(--accent); }
  .turn-timeline-svg { display: block; width: 100%; height: 2.25rem; padding: 0.15rem 0.25rem; border: 2px solid var(--border-subtle); background: var(--background); }
  .turn-bar { fill: var(--chart-3); cursor: pointer; opacity: 0.85; }
  .turn-bar[data-slot="primary"] { fill: var(--chart-1); }
  .turn-bar[data-slot="partner"] { fill: var(--chart-2); }
  .turn-bar[data-dimmed="true"] { opacity: 0.2; }
  .turn-bar[data-selected="true"], .turn-bar:hover { opacity: 1; stroke: var(--foreground); stroke-width: 1; }

  @media (max-width: 720px) {
    .toggle { display: inline-block; }
    aside { position: absolute; inset: 0 auto 0 0; z-index: 2; width: min(20rem, 85%); transform: translateX(-100%); transition: transform 0.15s; }
    aside.open { transform: none; }
    .actions { visibility: visible; }
    .bubble { max-width: 85%; }
    .stage-actors { grid-template-columns: minmax(0, 1fr); }
    .stage-actor-right { justify-content: flex-start; text-align: left; flex-direction: row-reverse; }
  }
</style>
