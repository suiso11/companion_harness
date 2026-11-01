// Hands-free voice E2E: the fake microphone feeds a tone/silence loop into the
// real capture → VAD → /api/transcribe → conversation path, and the avatar's
// TTS playback is interrupted (barge-in) when the user starts speaking.
//
// /api/transcribe and /api/speech are mocked here because the local engines
// are opt-in deployments; everything else (getUserMedia, ScriptProcessor,
// detector, Web Audio playback, run cancellation) is real.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

const SAMPLE_RATE = 16_000;

function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + pcm.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcm.length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i += 1) {
    buffer.writeInt16LE(pcm[i] as number, 44 + i * 2);
  }
  return buffer;
}

/** 1.2 s of 220 Hz followed by 2.8 s of silence: one utterance per loop. */
function fakeMicrophone(): string {
  const pcm = new Int16Array(SAMPLE_RATE * 4);
  for (let i = 0; i < SAMPLE_RATE * 1.2; i += 1) {
    pcm[i] = Math.round(
      Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 9_000,
    );
  }
  const file = join(mkdtempSync(join(tmpdir(), "ch-voice-")), "mic.wav");
  writeFileSync(file, wav(pcm, SAMPLE_RATE));
  return file;
}

/** 20 s of tone: long enough that barge-in interrupts it mid-playback. */
function longSpeech(): Buffer {
  const pcm = new Int16Array(8_000 * 20);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8_000) * 12_000);
  }
  return wav(pcm, 8_000);
}

test.use({
  permissions: ["microphone"],
  viewport: { width: 1280, height: 900 },
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeMicrophone()}`,
    ],
  },
});

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
});

test("speech becomes a turn, then interrupts the reply", async ({ page }) => {
  let transcriptions = 0;
  await page.route("**/api/transcribe", async (route) => {
    transcriptions += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "テスト発話" }),
    });
  });
  await page.route("**/api/speech", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: longSpeech(),
    });
  });

  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();

  const voice = page.locator("[data-voice-mode]");
  await voice.click();
  await expect(voice).toHaveAttribute("data-voice-mode", "on");

  // The captured utterance is transcribed and sent as a user turn.
  await expect(page.locator("#conversation")).toContainText("テスト発話", {
    timeout: 20_000,
  });
  await expect(page.locator("#conversation")).toContainText(`echo:テスト発話`, {
    timeout: 20_000,
  });

  // The answer is spoken, then the next spoken frame barges in and stops it
  // long before the 20 s clip could end on its own.
  await expect(voice).toHaveAttribute("data-speaking", "true", {
    timeout: 20_000,
  });
  const speakingSince = Date.now();
  await expect(voice).toHaveAttribute("data-speaking", "false", {
    timeout: 30_000,
  });
  expect(Date.now() - speakingSince).toBeLessThan(8_000);
  // The interruption came from a second captured utterance, not from a
  // playback failure: the next loop's speech was transcribed again.
  await expect.poll(() => transcriptions, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await page.locator("[data-voice-mode]").click();
});
