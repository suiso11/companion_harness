// Pure voice-loop logic: detector, resampler, WAV encoder, sentence feeder.
import { describe, expect, test } from "vitest";
import {
  type DetectorEvent,
  encodeWav,
  resample,
  rms,
  SentenceFeeder,
  splitSpeakable,
  UtteranceDetector,
} from "../src/lib/voice_loop.js";

const RATE = 16000;
// 10 ms frames; options in whole frames keep the arithmetic obvious.
const FRAME = 160;
const OPTS = {
  sampleRate: RATE,
  threshold: 0.1,
  minSpeechMs: 100,
  trailingSilenceMs: 200,
  maxUtteranceMs: 1000,
  preRollMs: 50,
};

function frame(value: number): Float32Array {
  return new Float32Array(FRAME).fill(value);
}

function run(
  detector: UtteranceDetector,
  value: number,
  count: number,
): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  for (let i = 0; i < count; i += 1)
    events.push(...detector.push(frame(value)));
  return events;
}

describe("rms", () => {
  test("constant signal and empty frame", () => {
    expect(rms(frame(0.5))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe("UtteranceDetector", () => {
  test("keeps pre-roll, fires speechStarted once, ends on trailing silence", () => {
    const d = new UtteranceDetector(OPTS);
    expect(run(d, 0.01, 10)).toEqual([]);
    const started = run(d, 0.5, 10);
    expect(started).toEqual([{ kind: "speechStarted" }]);
    const ended = run(d, 0.01, 20);
    expect(ended).toHaveLength(1);
    const ev = ended[0];
    if (ev?.kind !== "utterance") throw new Error("expected utterance");
    // 5 pre-roll frames + 10 loud + 20 silent.
    expect(ev.samples.length).toBe(35 * FRAME);
    expect(ev.samples[0]).toBeCloseTo(0.01);
    expect(ev.samples[5 * FRAME - 1]).toBeCloseTo(0.01);
    expect(ev.samples[5 * FRAME]).toBeCloseTo(0.5);
  });

  test("drops a burst shorter than minSpeechMs", () => {
    const d = new UtteranceDetector(OPTS);
    expect(run(d, 0.5, 3)).toEqual([]);
    expect(run(d, 0.01, 30)).toEqual([]);
  });

  test("short pauses inside speech do not end the utterance", () => {
    const d = new UtteranceDetector(OPTS);
    run(d, 0.5, 10);
    expect(run(d, 0.01, 10)).toEqual([]);
    run(d, 0.5, 5);
    const ended = run(d, 0.01, 20);
    expect(ended.filter((e) => e.kind === "utterance")).toHaveLength(1);
  });

  test("max length emits without silence and rearms", () => {
    const d = new UtteranceDetector(OPTS);
    const events = run(d, 0.5, 100);
    const utterances = events.filter((e) => e.kind === "utterance");
    expect(utterances).toHaveLength(1);
    const ev = utterances[0];
    if (ev?.kind !== "utterance") throw new Error("expected utterance");
    expect(ev.samples.length).toBe(100 * FRAME);
    expect(run(d, 0.5, 10)).toEqual([{ kind: "speechStarted" }]);
  });

  test("reset discards an utterance in progress", () => {
    const d = new UtteranceDetector(OPTS);
    run(d, 0.5, 10);
    d.reset();
    expect(run(d, 0.01, 30)).toEqual([]);
  });
});

describe("encodeWav", () => {
  test("44-byte RIFF header, 16-bit mono PCM, clamped samples", () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    const view = new DataView(bytes.buffer);
    const tag = (at: number): string =>
      String.fromCharCode(...bytes.subarray(at, at + 4));
    expect(bytes.length).toBe(44 + 8);
    expect(tag(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
  });
});

describe("resample", () => {
  test("same rate returns the input untouched", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resample(input, 16000)).toBe(input);
  });

  test("downsamples 48 kHz to 16 kHz", () => {
    const out = resample(new Float32Array(480).fill(0.25), 48000);
    expect(out.length).toBe(160);
    expect(out[80]).toBeCloseTo(0.25);
  });

  test("linearly interpolates when upsampling", () => {
    expect(Array.from(resample(new Float32Array([0, 1]), 8000))).toEqual([
      0, 0.5, 1, 1,
    ]);
  });
});

describe("SentenceFeeder", () => {
  test("returns only newly completed sentences", () => {
    const f = new SentenceFeeder();
    expect(f.push("こんにちは。元気？まだ")).toEqual({
      restarted: false,
      sentences: ["こんにちは。", "元気？"],
    });
    expect(f.push("こんにちは。元気？まだ終わり。")).toEqual({
      restarted: false,
      sentences: ["まだ終わり。"],
    });
  });

  test("splits on newline and ascii terminators", () => {
    expect(splitSpeakable("one\ntwo! three?")).toEqual([
      "one",
      "two!",
      "three?",
    ]);
  });

  test("flush returns the trailing fragment once", () => {
    const f = new SentenceFeeder();
    expect(f.push("あいう").sentences).toEqual([]);
    expect(f.flush()).toEqual(["あいう"]);
    expect(f.flush()).toEqual([]);
  });

  test("reports a restart when consumed text changes", () => {
    const f = new SentenceFeeder();
    f.push("あ。い。");
    expect(f.push("う。")).toEqual({ restarted: true, sentences: ["う。"] });
  });

  test("cap flushes a punctuation-free run, preferring a comma", () => {
    expect(
      new SentenceFeeder(5).push("あいうえおかきくけこ").sentences,
    ).toEqual(["あいうえお", "かきくけこ"]);
    expect(new SentenceFeeder(6).push("あい、うえおかき").sentences).toEqual([
      "あい、",
    ]);
  });

  test("strips code fences, inline code and citation markers", () => {
    expect(
      splitSpeakable(
        "説明です。```js\nconst a = 1。\n```次です[r12]。`x`を使う。",
      ),
    ).toEqual(["説明です。", "次です。", "を使う。"]);
  });

  test("an unclosed fence waits and is dropped on flush", () => {
    const f = new SentenceFeeder();
    expect(f.push("説明。```js\nfoo。").sentences).toEqual(["説明。"]);
    expect(f.flush()).toEqual([]);
  });

  test("skips fragments without letters or numbers", () => {
    expect(splitSpeakable("！！\nはい。...")).toEqual(["はい。"]);
  });
});
