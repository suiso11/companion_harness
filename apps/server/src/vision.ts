// Local image understanding: one JPEG + one question forwarded to a loopback
// OpenAI-compatible chat-completions endpoint. Nothing is persisted, logged
// or retried; every failure collapses to `{ ok: false }`.

import { MAX_VISION_IMAGE_BYTES } from "@companion/contracts";
import { resolveOpenAIChatUrl } from "@companion/model-local";
import type { VisionConfig } from "./config.js";

/** JSON envelope bound for the base64 body (must exceed the contract max). */
export const MAX_VISION_BODY_BYTES = 3_900_000;
const MAX_VISION_ANSWER_LENGTH = 4_000;
const MAX_VISION_TOKENS = 512;
const DEFAULT_QUESTION =
  "この画像に何が写っているかを、簡潔な日本語で説明してください。";

/** Decode the contract envelope, or null when it is not a bounded JPEG. */
export function decodeJpegBase64(base64: string): Uint8Array | null {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > MAX_VISION_IMAGE_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    return null;
  }
  return bytes;
}

export type VisionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

export async function askVision(
  config: VisionConfig,
  jpeg: Uint8Array,
  question: string | undefined,
): Promise<VisionResult> {
  let body: unknown;
  try {
    const response = await fetch(resolveOpenAIChatUrl(config.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_VISION_TOKENS,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: question ?? config.prompt ?? DEFAULT_QUESTION,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
      // Never re-POST the frame to a redirect target (loopback only).
      redirect: "error",
    });
    if (response.status !== 200) {
      return { ok: false };
    }
    body = await response.json();
  } catch {
    return { ok: false };
  }
  const content = (
    body as { choices?: Array<{ message?: { content?: unknown } }> } | null
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { ok: false };
  }
  const text = content.trim();
  if (text.length === 0 || text.length > MAX_VISION_ANSWER_LENGTH) {
    return { ok: false };
  }
  return { ok: true, text };
}
