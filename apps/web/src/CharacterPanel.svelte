<script lang="ts">
// Character panel: shows the avatar and speaks the newest completed answer.
//
// Audio synthesis belongs to the parallel audio track (POST /api/speech).
// This panel only consumes it, drives the mouth from the audio level, and
// stays silent (with a visible notice) when the endpoint is absent.
//
// CSP: no inline styles or style: directives; the mouth is an SVG attribute
// (`ry`) driven by state.

import { onMount } from "svelte";
import { fetchJson } from "./lib/api.js";
import { BehaviorBrain } from "./lib/avatar_behavior.js";
import {
  type CharacterAvatar,
  fetchCharacterConfig,
  fetchLatestAnswer,
  fetchSpeech,
  type LatestAnswer,
  mouthOpen,
} from "./lib/character.js";
import {
  activeMemoryCount,
  bubbleText,
  buildCharacterMeters,
  type CharacterMeter,
  type CharacterToday,
  countDiaryEntries,
  parseCharacterToday,
  relativeTimeLabel,
  todayLines,
} from "./lib/character_status.js";
import {
  captureCameraFrame,
  describeVision,
  postObservation,
} from "./lib/vision.js";

const POLL_MS = 3000;

let { pet = false }: { pet?: boolean } = $props();

let auto = $state(pet);
let level = $state(0);
let speaking = $state(false);
let visionBusy = $state(false);
// Pet mode: the brain drives this and the stage consumes it.
let walkX = $state(0.5);
let walkFacing = $state<-1 | 1>(1);
let walkAmount = $state(0);
let walkPhase = $state(0);
let walkMode = $state<"idle" | "walk" | "rest" | "interact">("idle");
let petBrain: BehaviorBrain | null = null;
let status = $state("回答を待っています");
let draft = $state("");
let latest = $state<LatestAnswer | null>(null);
let avatar = $state<CharacterAvatar | null>(null);
let meters = $state<CharacterMeter[]>([]);
let today = $state<CharacterToday | null>(null);
let bubbleTime = $state("");

const bubble = $derived(
  bubbleText(
    latest !== null ? latest.text : (today?.companionMessages.at(-1) ?? ""),
  ),
);
const lines = $derived(
  todayLines(
    // The bubble already shows the newest companion message when there is no
    // answer yet; do not repeat that same line in the activity block.
    today !== null && latest === null && today.companionMessages.length > 0
      ? {
          ...today,
          companionMessages: today.companionMessages.slice(0, -1),
        }
      : today,
  ),
);

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let raf = 0;
let samples: Uint8Array<ArrayBuffer> | null = null;
let lastRunId: string | null = null;
let destroyed = false;

function stop(): void {
  if (audio !== null) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (raf !== 0) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  level = 0;
  speaking = false;
  petBrain?.resume();
}

function tick(): void {
  if (analyser === null || destroyed) {
    return;
  }
  samples ??= new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const value of samples) {
    const x = (value - 128) / 128;
    sum += x * x;
  }
  level = mouthOpen(Math.sqrt(sum / samples.length) * 3);
  raf = requestAnimationFrame(tick);
}

async function play(blob: Blob): Promise<void> {
  stop();
  ctx ??= new AudioContext();
  await ctx.resume();
  objectUrl = URL.createObjectURL(blob);
  const element = new Audio(objectUrl);
  audio = element;
  const source = ctx.createMediaElementSource(element);
  analyser ??= ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  element.onended = () => stop();
  speaking = true;
  // While the pet speaks it stands still and turns to the viewer.
  petBrain?.interrupt();
  await element.play();
  tick();
}

async function speak(text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return;
  }
  status = "音声を取得しています";
  const blob = await fetchSpeech(trimmed);
  if (blob === null) {
    status = "音声側が未接続です（音声トラックの実装待ち）";
    return;
  }
  status = "話しています";
  await play(blob);
}

async function refresh(): Promise<void> {
  const answer = await fetchLatestAnswer();
  if (destroyed) {
    return;
  }
  if (answer !== null) {
    latest = answer;
  }
  bubbleTime =
    latest?.finishedAt != null
      ? relativeTimeLabel(Date.now(), latest.finishedAt)
      : "";
  if (answer === null) {
    status = "回答がまだありません";
    return;
  }
  if (answer.runId === lastRunId) {
    return;
  }
  lastRunId = answer.runId;
  status = "新しい回答があります";
  void loadCard();
  if (auto) {
    await speak(answer.text);
  }
}

/** Portrait-card side data: meter counts and today's activity block. */
async function loadCard(): Promise<void> {
  if (pet) {
    return;
  }
  const [stats, diary, todayRes] = await Promise.all([
    fetchJson("/api/memory/stats"),
    fetchJson("/api/diary?limit=100"),
    fetchJson("/api/character/today"),
  ]);
  if (destroyed) {
    return;
  }
  meters = buildCharacterMeters({
    activeMemories: stats.status === 200 ? activeMemoryCount(stats.body) : null,
    diaryEntries: diary.status === 200 ? countDiaryEntries(diary.body) : null,
  });
  today = todayRes.status === 200 ? parseCharacterToday(todayRes.body) : null;
}

async function speakLatest(): Promise<void> {
  const answer = latest ?? (await fetchLatestAnswer());
  if (answer === null) {
    status = "回答がまだありません";
    return;
  }
  latest = answer;
  lastRunId = answer.runId;
  await speak(answer.text);
}

async function speakDraft(): Promise<void> {
  await speak(draft);
}

/** One camera frame → local vision model → a turn the companion answers. */
async function lookWithCamera(): Promise<void> {
  if (visionBusy) {
    return;
  }
  visionBusy = true;
  status = "カメラを確認しています";
  try {
    const frame = await captureCameraFrame();
    if (frame === null) {
      status = "カメラを使えません";
      return;
    }
    const seen = await describeVision(frame);
    if (seen === null) {
      status = "視覚側が未接続です（COMPANION_VISION_JSON 未設定）";
      return;
    }
    status = `見えているもの: ${seen}`;
    // The poller speaks the run this observation produces; the previous
    // answer must not be replayed here.
    if (!(await postObservation(seen))) {
      status = "観察を送信できませんでした";
    }
  } finally {
    visionBusy = false;
  }
}

onMount(() => {
  void (async () => {
    avatar = await fetchCharacterConfig();
  })();
  void loadCard();
  // Pet mode owns itself: a local HFSM picks idle/walk/rest and the stage
  // turns the snapshot into movement + a procedural walk cycle.
  let petRaf = 0;
  if (pet) {
    // Tests inject a deterministic RNG; production keeps Math.random.
    const random =
      (globalThis as { __petRandom?: () => number }).__petRandom ?? Math.random;
    const brain = new BehaviorBrain(random);
    petBrain = brain;
    let last = performance.now();
    const loop = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      const snap = brain.update(dt);
      walkX = snap.x;
      walkFacing = snap.facing;
      walkAmount = snap.speed;
      walkPhase = snap.walkPhase;
      walkMode = snap.mode;
      petRaf = requestAnimationFrame(loop);
    };
    petRaf = requestAnimationFrame(loop);
  }
  // Remember the newest existing answer without voicing it on load: only
  // answers that complete while the panel is open are spoken.
  void (async () => {
    const answer = await fetchLatestAnswer();
    if (destroyed) {
      return;
    }
    if (answer !== null) {
      latest = answer;
      lastRunId = answer.runId;
    }
    await refresh();
  })();
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") {
      void refresh();
    }
  }, POLL_MS);
  return () => {
    destroyed = true;
    petBrain = null;
    clearInterval(timer);
    cancelAnimationFrame(petRaf);
    stop();
    void ctx?.close();
  };
});
</script>

<section class="character" class:pet data-character-panel="true">
  <div
    class="card"
    data-character-card={pet ? undefined : "true"}
  >
    <div class="portrait">
      <div
        class="stage"
        data-speaking={speaking ? "true" : "false"}
        data-move={walkMode}
        data-x={walkX.toFixed(3)}
      >
        {#if avatar?.kind === "vrm"}
          {#await import("./VrmStage.svelte") then mod}
            <svelte:component this={mod.default} url={avatar.url} {level} />
          {:catch}
            <p class="notice">3Dステージを読み込めませんでした</p>
          {/await}
        {:else if avatar?.kind === "fbx"}
          {#await import("./FbxStage.svelte") then mod}
            <svelte:component
              this={mod.default}
              url={avatar.url}
              texturesUrl={avatar.texturesUrl}
              version={avatar.assetVersion}
              {level}
              x={walkX}
              facing={walkFacing}
              walk={walkAmount}
              {walkPhase}
              mode={walkMode}
              rest={walkMode === "rest" ? 1 : 0}
            />
          {:catch}
            <p class="notice">3Dステージを読み込めませんでした</p>
          {/await}
        {:else}
          <svg
            class="avatar"
            viewBox="0 0 200 220"
            role="img"
            aria-label="春琴のアバター"
            data-character-avatar="true"
          >
            <path
              class="hair"
              d="M100 18c-44 0-70 28-70 70 0 22 8 40 18 52l10-6c-6-14-8-30-6-44 12 10 30 16 48 16s36-6 48-16c2 14 0 30-6 44l10 6c10-12 18-30 18-52 0-42-26-70-70-70z"
            />
            <circle class="face" cx="100" cy="96" r="52" />
            <ellipse class="eye" cx="80" cy="92" rx="5" ry="7" />
            <ellipse class="eye" cx="120" cy="92" rx="5" ry="7" />
            <ellipse
              class="mouth"
              cx="100"
              cy="122"
              rx="12"
              ry={3 + 10 * level}
            />
          </svg>
        {/if}
      </div>

      {#if !pet}
        {#if bubble !== ""}
          <p class="bubble" data-character-bubble>
            {bubble}
            {#if bubbleTime !== ""}
              <span class="bubble-time" data-character-bubble-time>
                {bubbleTime}
              </span>
            {/if}
          </p>
        {/if}
        <p class="nameplate" data-character-nameplate>春琴</p>
      {/if}
    </div>

    {#if !pet}
      {#if meters.length > 0}
        <ul class="meters" data-character-meters aria-label="ステータス">
          {#each meters as meter (meter.key)}
            <li class="meter" data-character-meter={meter.key}>
              <span class="meter-label">{meter.label}</span>
              <svg
                viewBox="0 0 100 8"
                width="100%"
                height="8"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect
                  class="meter-track"
                  x="0"
                  y="0"
                  width="100"
                  height="8"
                  rx="2"
                ></rect>
                <rect
                  class="meter-fill"
                  x="0"
                  y="0"
                  width={meter.percent}
                  height="8"
                  rx="2"
                ></rect>
              </svg>
              <span class="meter-value">{meter.value}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if today !== null}
        <section class="today" data-character-today aria-label="今日のあなた">
          <h3>今日のあなた</h3>
          {#if lines.length > 0}
            <ul>
              {#each lines as line}
                <li>{line}</li>
              {/each}
            </ul>
          {:else}
            <p class="today-empty">今日の記録はまだありません</p>
          {/if}
        </section>
      {/if}
    {/if}
  </div>

  {#if !pet}
    <div class="controls">
      <div class="row">
        <button type="button" onclick={() => void speakLatest()}>
          最新の回答を話す
        </button>
        <label class="toggle">
          <input type="checkbox" bind:checked={auto} />
          自動で話す
        </label>
      </div>
      <div class="row">
        <input
          class="draft"
          type="text"
          placeholder="試聴する文"
          bind:value={draft}
        />
        <button type="button" onclick={() => void speakDraft()}>試聴</button>
      </div>
      <div class="row">
        <button
          type="button"
          disabled={visionBusy}
          onclick={() => void lookWithCamera()}
        >
          カメラで見る
        </button>
        <p class="status" data-character-status="true">{status}</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .character {
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    padding: 24px;
  }
  /* Pet window: transparent, edge-to-edge avatar, no page chrome. */
  .character.pet {
    height: 100vh;
    padding: 0;
    gap: 0;
    justify-content: flex-end;
  }
  /* Card chrome is page-only: in pet mode it must not wrap the stage. */
  .character.pet .card,
  .character.pet .portrait {
    display: contents;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(360px, 92vw);
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
  }
  .portrait {
    position: relative;
    display: flex;
    justify-content: center;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  /* Character line over the portrait, with the elapsed-time tag. */
  .bubble {
    position: absolute;
    top: 10px;
    left: 10px;
    right: 10px;
    margin: 0;
    padding: 8px 10px;
    max-height: 7.5em;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--popover);
    color: var(--popover-foreground);
    font-size: 0.85rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .bubble-time {
    display: block;
    margin-top: 4px;
    color: var(--muted-foreground);
    font-size: 0.75em;
    text-align: right;
  }
  .nameplate {
    position: absolute;
    left: 10px;
    bottom: 10px;
    margin: 0;
    padding: 4px 14px;
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 600;
  }
  .meters,
  .today ul {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .meters {
    gap: 8px;
  }
  .meter {
    display: grid;
    grid-template-columns: 3.5em 1fr 3em;
    align-items: center;
    gap: 10px;
    font-size: 0.85rem;
  }
  .meter-label {
    color: var(--muted-foreground);
  }
  .meter-track {
    fill: var(--muted);
  }
  .meter-fill {
    fill: var(--chart-1, var(--accent));
  }
  .today {
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .today h3 {
    margin: 0 0 6px;
    color: var(--muted-foreground);
    font-size: 0.85rem;
  }
  .today ul {
    gap: 4px;
    font-size: 0.82rem;
  }
  .today li {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .today-empty {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }
  .meter-value {
    text-align: right;
  }
  .character.pet .stage,
  .character.pet :global([data-vrm-stage]),
  .character.pet :global([data-fbx-stage]) {
    width: 100%;
    height: 100vh;
  }
  .stage {
    width: min(320px, 70vw);
  }
  .avatar {
    width: 100%;
    height: auto;
    display: block;
  }
  .hair {
    fill: var(--border, #444);
  }
  .face {
    fill: var(--surface, #f5f5f5);
    stroke: var(--border, #444);
    stroke-width: 2;
  }
  .eye {
    fill: var(--fg, #111);
  }
  .mouth {
    fill: var(--accent, #b05a5a);
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(420px, 90vw);
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .draft {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--border, #444);
    border-radius: 6px;
    background: var(--surface, #fff);
    color: var(--fg, #111);
  }
  .toggle {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .status {
    margin: 0;
    color: var(--muted-foreground, #666);
    font-size: 0.9em;
  }
  .notice {
    margin: 0;
    color: var(--muted-foreground, #666);
    font-size: 0.9em;
  }
</style>
