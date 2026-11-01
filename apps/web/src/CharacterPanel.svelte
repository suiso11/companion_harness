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
import {
  fetchLatestAnswer,
  fetchSpeech,
  type LatestAnswer,
  mouthOpen,
} from "./lib/character.js";

const POLL_MS = 3000;

let auto = $state(false);
let level = $state(0);
let speaking = $state(false);
let status = $state("回答を待っています");
let draft = $state("");
let latest = $state<LatestAnswer | null>(null);

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
  if (answer === null) {
    status = "回答がまだありません";
    return;
  }
  latest = answer;
  if (answer.runId === lastRunId) {
    return;
  }
  lastRunId = answer.runId;
  status = "新しい回答があります";
  if (auto) {
    await speak(answer.text);
  }
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

onMount(() => {
  void refresh();
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") {
      void refresh();
    }
  }, POLL_MS);
  return () => {
    destroyed = true;
    clearInterval(timer);
    stop();
    void ctx?.close();
  };
});
</script>

<section class="character" data-character-panel="true">
  <div class="stage" data-speaking={speaking ? "true" : "false"}>
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
  </div>

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
    <p class="status" data-character-status="true">{status}</p>
  </div>
</section>

<style>
  .character {
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    padding: 24px;
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
    color: var(--muted, #666);
    font-size: 0.9em;
  }
</style>
