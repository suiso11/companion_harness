// DOM glue for hands-free voice: mic capture -> VAD -> /api/transcribe, and
// sentence queue -> /api/speech -> Web Audio playback. Decisions (barge-in,
// what to say) belong to the caller; the pure logic is in voice_loop.ts.
import {
  ASR_SAMPLE_RATE,
  DEFAULT_DETECTOR_OPTIONS,
  encodeWav,
  resample,
  UtteranceDetector,
} from "./voice_loop.js";

const NO_VOICE_CONFIG = "音声設定がありません";

export interface VoiceSessionHandlers {
  /** Speech began (voiced for minSpeechMs): the caller decides on barge-in. */
  onSpeechStart(): void;
  onUtterance(text: string): void;
  onNotice(text: string): void;
}

export interface VoiceSession {
  stop(): void;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(bin);
}

/** Rejects when the microphone is unavailable (caller shows the notice). */
export async function startVoiceSession(
  handlers: VoiceSessionHandlers,
): Promise<VoiceSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
  } catch {
    // Some engines refuse a fixed rate; resample below instead.
    ctx = new AudioContext();
  }
  const source = ctx.createMediaStreamSource(stream);
  // shortcut: ScriptProcessorNode is deprecated, but the strict CSP
  // (no blob:/module worklet URLs) leaves it as the only PCM capture; move
  // to an AudioWorklet served from 'self' when the CSP allows a worklet.
  const processor = ctx.createScriptProcessor(512, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // a processor only ticks while connected onward
  const detector = new UtteranceDetector({
    ...DEFAULT_DETECTOR_OPTIONS,
    sampleRate: ctx.sampleRate,
  });
  let stopped = false;
  let configNoticeShown = false;

  async function transcribe(samples: Float32Array): Promise<void> {
    const pcm = resample(samples, ctx.sampleRate, ASR_SAMPLE_RATE);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audioBase64: toBase64(encodeWav(pcm)) }),
      });
      if (res.status === 404) {
        if (!configNoticeShown) {
          configNoticeShown = true;
          handlers.onNotice(NO_VOICE_CONFIG);
        }
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { text?: unknown };
      if (stopped || typeof body.text !== "string") return;
      const text = body.text.trim();
      if (text.length > 0) handlers.onUtterance(text);
    } catch {
      // Nothing heard / network blip: keep listening.
    }
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    // The engine reuses the input buffer; copy before keeping it.
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    for (const ev of detector.push(frame)) {
      if (ev.kind === "speechStarted") handlers.onSpeechStart();
      else void transcribe(ev.samples);
    }
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
      for (const track of stream.getTracks()) track.stop();
      detector.reset();
      void ctx.close().catch(() => {});
    },
  };
}

interface QueueItem {
  readonly text: string;
  audio: Promise<AudioBuffer | null> | null;
}

export interface VoicePlayback {
  enqueue(text: string): void;
  /** Stops the current sentence and drops everything queued. */
  reset(): void;
  /** `reset()` plus releasing the audio context. */
  dispose(): void;
}

/** Create from a user gesture so the audio context may start. */
export function createVoicePlayback(
  onSpeaking: (speaking: boolean) => void,
): VoicePlayback {
  const ctx = new AudioContext();
  let queue: QueueItem[] = [];
  let current: AudioBufferSourceNode | null = null;
  // Bumped by reset(): an older loop must never touch the new queue.
  let epoch = 0;
  let running = false;
  let disposed = false;

  async function fetchAudio(text: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch("/api/speech", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ text }] }),
      });
      if (!res.ok) return null;
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  function prefetchHead(): void {
    const head = queue[0];
    if (head !== undefined) head.audio ??= fetchAudio(head.text);
  }

  function play(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => resolve();
      current = node;
      node.start();
    });
  }

  async function run(): Promise<void> {
    const mine = epoch;
    running = true;
    onSpeaking(true);
    while (mine === epoch && queue.length > 0) {
      prefetchHead();
      const audio = await queue[0]?.audio;
      if (mine !== epoch) return;
      queue.shift();
      prefetchHead(); // next sentence downloads while this one plays
      if (audio) {
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        if (mine !== epoch) return;
        await play(audio);
        if (mine !== epoch) return;
        current = null;
      }
    }
    running = false;
    onSpeaking(false);
  }

  function reset(): void {
    epoch += 1;
    queue = [];
    const node = current;
    current = null;
    if (node !== null) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already ended.
      }
    }
    if (running) {
      running = false;
      onSpeaking(false);
    }
  }

  return {
    enqueue(text: string): void {
      if (disposed) return;
      queue.push({ text, audio: null });
      prefetchHead();
      if (!running) void run();
    },
    reset,
    dispose(): void {
      disposed = true;
      reset();
      void ctx.close().catch(() => {});
    },
  };
}
