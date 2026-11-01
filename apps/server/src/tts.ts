// Local VOICEVOX-compatible TTS forwarding for the avatar client.
//
// One finished answer == one request: the voiced parts are joined with a
// newline (a phrase break for the engine) and synthesized by a single
// audio_query + synthesis pair, so the client receives exactly one WAV and
// needs no timing data (lip sync runs on its own analyser). The engine is a
// separate loopback service; nothing is persisted, nothing is retried, and
// every failure is reported to the caller as a fixed failure (the avatar
// stays silent, the chat answer is never affected).

import type { TtsConfig } from "./config.js";

/** Upper bound for one synthesized answer (defensive; answers are short). */
export const MAX_TTS_AUDIO_BYTES = 8 * 1024 * 1024;

export type TtsResult =
  | { readonly ok: true; readonly wav: ArrayBuffer }
  | { readonly ok: false };

export async function synthesizeSpeech(
  config: TtsConfig,
  parts: readonly string[],
): Promise<TtsResult> {
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
  if (text.length === 0) {
    return { ok: false };
  }
  const signal = AbortSignal.timeout(config.timeoutMs);
  let query: unknown;
  try {
    const response = await fetch(
      `${config.url}/audio_query?speaker=${config.speaker}&text=${encodeURIComponent(text)}`,
      { method: "POST", signal },
    );
    if (!response.ok) {
      return { ok: false };
    }
    query = await response.json();
  } catch {
    return { ok: false };
  }
  if (typeof query !== "object" || query === null) {
    return { ok: false };
  }
  try {
    const response = await fetch(
      `${config.url}/synthesis?speaker=${config.speaker}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
        signal,
      },
    );
    if (!response.ok) {
      return { ok: false };
    }
    const declared = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declared) &&
      declared > 0 &&
      declared > MAX_TTS_AUDIO_BYTES
    ) {
      return { ok: false };
    }
    const wav = await response.arrayBuffer();
    if (wav.byteLength === 0 || wav.byteLength > MAX_TTS_AUDIO_BYTES) {
      return { ok: false };
    }
    return { ok: true, wav };
  } catch {
    return { ok: false };
  }
}
