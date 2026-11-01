// Local whisper.cpp ASR forwarding for hands-free voice input.
//
// One captured utterance == one request. The engine is a separate loopback
// service; this module only translates the envelope (base64 JSON -> WAV
// multipart) and normalizes what comes back.
//
// Misrecognition defense, in the only forms that stay local and
// deterministic:
// - the operator's `prompt` is sent as the decoder bias (names/domain terms),
// - a fixed non-speech artifact list becomes "" so the caller keeps listening
//   instead of sending a turn built from 「ご視聴ありがとうございました」,
// - NFKC + whitespace/bracket cleanup removes what the engine adds around
//   real speech.
// There is no confidence field: the engine does not report one in the JSON
// response, so the caller decides (the client keeps the transcript editable
// before it becomes a turn). Nothing is persisted and nothing is retried.

import type { AsrConfig } from "./config.js";

/** JSON envelope bound for the base64 body (must exceed the contract max). */
export const MAX_TRANSCRIBE_BODY_BYTES = 2_900_000;

/**
 * Fixed engine artifacts that are never a real utterance in this harness.
 * Matched after normalization, exactly.
 */
const NON_SPEECH_TEXTS: Readonly<Record<string, true>> = {
  ご視聴ありがとうございました: true,
  ご視聴ありがとうございます: true,
  ご視聴いただきありがとうございました: true,
  チャンネル登録お願いします: true,
};

/** Decode the contract envelope, or null when it is not a small WAV. */
export function decodeWavBase64(
  base64: string,
  maxBytes: number,
): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return null;
  }
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x41 ||
    bytes[10] !== 0x56 ||
    bytes[11] !== 0x45
  ) {
    return null;
  }
  return bytes;
}

/**
 * Normalize one engine transcript. Empty means "nothing usable": the caller
 * must not turn it into a turn.
 */
export function normalizeTranscript(raw: string): string {
  const text = raw
    .normalize("NFKC")
    // Bracketed engine annotations ([BLANK_AUDIO], [音楽], ...) are not speech.
    .replace(/\[[^\]\n]{0,32}\]/g, " ")
    .replace(/\s+/g, " ")
    // A lone leading/trailing separator is engine hygiene, not content.
    .replace(/^[。、,.!?！？…・\s]+/, "")
    .replace(/[。、,.!?！？…・\s]+$/, "")
    .trim();
  if (text.length === 0) {
    return "";
  }
  if (NON_SPEECH_TEXTS[text] === true) {
    return "";
  }
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return "";
  }
  return text;
}

export type AsrResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

export async function transcribeVoice(
  config: AsrConfig,
  wav: Uint8Array,
): Promise<AsrResult> {
  const form = new FormData();
  // The copy gives Blob an ArrayBuffer-backed view; the typed input view is
  // generic over ArrayBufferLike and is not assignable to BlobPart.
  form.append(
    "file",
    new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
    "utterance.wav",
  );
  form.append("language", "ja");
  form.append("response_format", "json");
  if (config.prompt !== null) {
    form.append("prompt", config.prompt);
  }
  const signal = AbortSignal.timeout(config.timeoutMs);
  let body: unknown;
  try {
    const response = await fetch(`${config.url}/inference`, {
      method: "POST",
      body: form,
      signal,
    });
    if (!response.ok) {
      return { ok: false };
    }
    body = await response.json();
  } catch {
    return { ok: false };
  }
  if (typeof body !== "object" || body === null || !("text" in body)) {
    return { ok: false };
  }
  const text = body.text;
  if (typeof text !== "string") {
    return { ok: false };
  }
  return { ok: true, text: normalizeTranscript(text) };
}
