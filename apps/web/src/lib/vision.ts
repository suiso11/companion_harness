/// <reference lib="dom" />
// Camera vision for the character page.
//
// One capture is one request: the camera is opened, one JPEG frame is taken
// and the device is released. `POST /api/vision` runs the local vision model
// (strict opt-in server side); the answer is attached to the newest session
// as the user's message, so the companion replies and the existing auto-speak
// path voices it. No frame is stored.

import { fetchJson, postJson, randomUuid } from "./api.js";
import { newestSessionId } from "./character.js";

/** Grab one camera frame as a JPEG data URL, or null without a camera. */
export async function captureCameraFrame(): Promise<string | null> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Cameras need a moment to settle exposure/white balance: an immediate
    // frame is often black and the vision model then describes darkness.
    const settled = Promise.withResolvers<void>();
    setTimeout(() => settled.resolve(), 500);
    await settled.promise;
    const bitmap = await createImageBitmap(video);
    try {
      // Bound the request: a 4K webcam still describes fine at 640px.
      const width = Math.min(bitmap.width, 640);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((bitmap.height * width) / bitmap.width);
      const context = canvas.getContext("2d");
      if (context === null) {
        return null;
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  } finally {
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
  }
}

/** One description of the frame, or null when vision is unset/failed. */
export async function describeVision(
  imageDataUrl: string,
): Promise<string | null> {
  const base64 = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  if (base64 === "") {
    return null;
  }
  const result = await postJson("/api/vision", { imageBase64: base64 }, null);
  if (result.status !== 200) {
    return null;
  }
  const text = (result.body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  return text.trim();
}

/**
 * Attach the observation to the newest session (creating one if needed).
 * The caption travels in `uiContext.observation`, so the turn's user text
 * stays the user's own words and memory never records the caption as speech.
 */
export async function postObservation(observation: string): Promise<boolean> {
  const list = await fetchJson("/api/sessions?limit=1");
  let sessionId = list.status === 200 ? newestSessionId(list.body) : null;
  if (sessionId === null) {
    const created = await postJson("/api/sessions", {}, randomUuid());
    const id = (created.body as { sessionId?: unknown } | null)?.sessionId;
    if (created.status !== 201 || typeof id !== "string") {
      return false;
    }
    sessionId = id;
  }
  const posted = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    { text: "カメラを見て", uiContext: { observation } },
    randomUuid(),
  );
  return posted.status === 202;
}
