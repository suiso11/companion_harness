/// <reference lib="dom" />
// Character page helpers (frontend plan §character).
//
// The character panel is a consumer: the audio track owns synthesis. This
// module only reads the newest completed answer and maps an audio level to
// a mouth opening. No synthesis, no session state, no polling loop here.

import { fetchJson } from "./api.js";
import { runResultToAnswerParts } from "./reducer.js";

export interface LatestAnswer {
  readonly runId: string;
  readonly text: string;
}

/** Map a 0..1 RMS level to a 0..1 mouth opening (perceptual curve). */
export function mouthOpen(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  const clamped = Math.min(Math.max(level, 0), 1);
  return Math.sqrt(clamped);
}

/**
 * Extract the newest completed answer from `GET /api/sessions/:id/history`.
 * The voiced projection wins when it is exactly aligned; otherwise the
 * canonical parts are used (same rule as the chat page).
 */
export function extractLatestAnswer(body: unknown): LatestAnswer | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const selected = (item as { selectedRun?: unknown }).selectedRun;
    if (typeof selected !== "object" || selected === null) {
      continue;
    }
    const run = selected as { runId?: unknown; result?: unknown };
    if (typeof run.runId !== "string") {
      continue;
    }
    const parts = runResultToAnswerParts(run.result, { preferVoice: true });
    const text = parts
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    if (text !== "") {
      return { runId: run.runId, text };
    }
  }
  return null;
}

/** Newest session id from `GET /api/sessions?limit=1` (null when empty). */
export function newestSessionId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const sessions = (body as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }
  const first = sessions[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Same-origin VRM URL from the server, or null when no model is set up. */
export async function fetchCharacterConfig(): Promise<string | null> {
  const res = await fetchJson("/api/character/config");
  if (res.status !== 200) {
    return null;
  }
  const body = res.body as { vrmUrl?: unknown };
  return typeof body.vrmUrl === "string" ? body.vrmUrl : null;
}

/** Read the newest completed answer, or null when there is none yet. */
export async function fetchLatestAnswer(): Promise<LatestAnswer | null> {
  const list = await fetchJson("/api/sessions?limit=1");
  if (list.status !== 200) {
    return null;
  }
  const sessionId = newestSessionId(list.body);
  if (sessionId === null) {
    return null;
  }
  const history = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=1`,
  );
  if (history.status !== 200) {
    return null;
  }
  return extractLatestAnswer(history.body);
}

/**
 * Ask the audio track for one answer's speech. Returns null on any failure
 * (the caller keeps the avatar silent and the answer visible).
 */
export async function fetchSpeech(text: string): Promise<Blob | null> {
  let response: Response;
  try {
    response = await fetch("/api/speech", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({ parts: [{ text }] }),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/")) {
    return null;
  }
  return response.blob();
}
