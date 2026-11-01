// Hands-free voice loop: pure logic (no DOM, no timers). The DOM glue lives
// in voice_session.ts; everything here is driven by frames/text so it can be
// unit-tested deterministically.

export const ASR_SAMPLE_RATE = 16000;

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

export interface DetectorOptions {
  readonly sampleRate: number;
  /** RMS at or above this counts as speech. */
  readonly threshold: number;
  /** Voiced audio needed before `speechStarted` fires (rejects clicks). */
  readonly minSpeechMs: number;
  /** Continuous quiet after speech that ends the utterance. */
  readonly trailingSilenceMs: number;
  /** Hard cap: the utterance is emitted even without silence. */
  readonly maxUtteranceMs: number;
  /** Audio kept from before the first loud frame (first syllable). */
  readonly preRollMs: number;
}

export const DEFAULT_DETECTOR_OPTIONS: Omit<DetectorOptions, "sampleRate"> = {
  threshold: 0.015,
  minSpeechMs: 250,
  trailingSilenceMs: 900,
  maxUtteranceMs: 20000,
  preRollMs: 300,
};

export type DetectorEvent =
  | { readonly kind: "speechStarted" }
  | { readonly kind: "utterance"; readonly samples: Float32Array };

function concat(chunks: readonly Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Frame-driven end-of-utterance detector. Callers must pass frames they own. */
export class UtteranceDetector {
  private readonly preRollSamples: number;
  private readonly minSpeech: number;
  private readonly trailing: number;
  private readonly max: number;
  private preRoll: Float32Array[] = [];
  private preRollLen = 0;
  private chunks: Float32Array[] = [];
  private len = 0;
  private voiced = 0;
  private silence = 0;
  private active = false;
  private started = false;

  constructor(private readonly opts: DetectorOptions) {
    const perMs = opts.sampleRate / 1000;
    this.preRollSamples = Math.round(opts.preRollMs * perMs);
    this.minSpeech = Math.round(opts.minSpeechMs * perMs);
    this.trailing = Math.round(opts.trailingSilenceMs * perMs);
    this.max = Math.round(opts.maxUtteranceMs * perMs);
  }

  reset(): void {
    this.preRoll = [];
    this.preRollLen = 0;
    this.chunks = [];
    this.len = 0;
    this.voiced = 0;
    this.silence = 0;
    this.active = false;
    this.started = false;
  }

  push(frame: Float32Array): DetectorEvent[] {
    const out: DetectorEvent[] = [];
    const loud = rms(frame) >= this.opts.threshold;
    if (!this.active) {
      if (!loud) {
        this.preRoll.push(frame);
        this.preRollLen += frame.length;
        while (
          this.preRoll.length > 1 &&
          this.preRollLen - (this.preRoll[0]?.length ?? 0) >=
            this.preRollSamples
        ) {
          this.preRollLen -= this.preRoll.shift()?.length ?? 0;
        }
        return out;
      }
      this.active = true;
      this.chunks = [...this.preRoll, frame];
      this.len = this.preRollLen + frame.length;
      this.preRoll = [];
      this.preRollLen = 0;
      this.voiced = frame.length;
    } else {
      this.chunks.push(frame);
      this.len += frame.length;
      if (loud) {
        this.voiced += frame.length;
        this.silence = 0;
      } else {
        this.silence += frame.length;
      }
    }
    if (!this.started && this.voiced >= this.minSpeech) {
      this.started = true;
      out.push({ kind: "speechStarted" });
    }
    if (this.silence >= this.trailing || this.len >= this.max) {
      // A burst that never reached minSpeech is dropped silently.
      if (this.started) {
        out.push({
          kind: "utterance",
          samples: concat(this.chunks, this.len),
        });
      }
      this.reset();
    }
    return out;
  }
}

/** Linear resample; fine for speech going to an ASR engine. */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number = ASR_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate) return input;
  const outLen = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const a = input[lo] ?? 0;
    const b = input[Math.min(lo + 1, input.length - 1)] ?? a;
    out[i] = a + (b - a) * (pos - lo);
  }
  return out;
}

/** 44-byte RIFF header + 16-bit little-endian mono PCM. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number = ASR_SAMPLE_RATE,
): Uint8Array {
  const dataLen = samples.length * 2;
  const bytes = new Uint8Array(44 + dataLen);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1)
      view.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

// --- TTS sentence feeding ---

const TERMINATORS = "。．！？!?\n";
const SOFT_BREAKS = "、，,";
export const DEFAULT_MAX_SENTENCE_CHARS = 80;

/** Text as it should be spoken: no code, no `[r12]` citation markers. */
export function toSpeakable(raw: string): string {
  return raw
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`]*(?:`|$)/g, " ")
    .replace(/\[r\d+(?:\s*,\s*r\d+)*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speakableOrNull(raw: string): string | null {
  const text = toSpeakable(raw);
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}

export interface FeedResult {
  /** The text no longer extends what was already consumed: stop playback. */
  readonly restarted: boolean;
  readonly sentences: string[];
}

/** Turns a growing draft text into finished, speakable sentences. */
export class SentenceFeeder {
  private consumed = 0;
  private consumedText = "";
  private lastText = "";

  constructor(private readonly maxChars: number = DEFAULT_MAX_SENTENCE_CHARS) {}

  reset(): void {
    this.consumed = 0;
    this.consumedText = "";
    this.lastText = "";
  }

  /** `text` is the whole accumulated text, not a delta. */
  push(text: string): FeedResult {
    const restarted = !text.startsWith(this.consumedText);
    if (restarted) this.reset();
    this.lastText = text;
    const sentences: string[] = [];
    let start = this.consumed;
    let i = start;
    while (i < text.length) {
      // Code spans are skipped whole; an unclosed one waits for more text.
      const fence = text.startsWith("```", i)
        ? "```"
        : text[i] === "`"
          ? "`"
          : null;
      if (fence !== null) {
        const close = text.indexOf(fence, i + fence.length);
        if (close === -1) break;
        i = close + fence.length;
        continue;
      }
      const ch = text[i] ?? "";
      if (TERMINATORS.includes(ch)) {
        i += 1;
        while (i < text.length && TERMINATORS.includes(text[i] ?? "")) i += 1;
        const s = speakableOrNull(text.slice(start, i));
        if (s !== null) sentences.push(s);
        start = i;
        continue;
      }
      i += 1;
      if (i - start >= this.maxChars) {
        const soft = Math.max(
          ...[...SOFT_BREAKS].map((b) => text.lastIndexOf(b, i - 1)),
        );
        if (soft >= start) i = soft + 1;
        const s = speakableOrNull(text.slice(start, i));
        if (s !== null) sentences.push(s);
        start = i;
      }
    }
    this.consumed = start;
    this.consumedText = text.slice(0, start);
    return { restarted, sentences };
  }

  /** The unfinished trailing fragment of the last pushed text, if speakable. */
  flush(): string[] {
    const tail = speakableOrNull(this.lastText.slice(this.consumed));
    this.consumed = this.lastText.length;
    this.consumedText = this.lastText;
    return tail === null ? [] : [tail];
  }
}

/** One-shot: split a finished text into speakable sentences. */
export function splitSpeakable(text: string): string[] {
  const feeder = new SentenceFeeder();
  return [...feeder.push(text).sentences, ...feeder.flush()];
}
