// Shared reactive session store (PR-5 review fix, session-rebinding group).
//
// ChatPage owns the session lifecycle (boot probe/create, switch, new). It
// mirrors every change into this store; every feature panel subscribes to
// `sessionId` with a `$effect` so a session change (or a session becoming
// available late, e.g. a direct deep-link into /trials before boot finishes)
// refetches / resets that panel — replacing the per-panel localStorage
// polling watchers with one reactive source of truth. localStorage stays the
// durable mirror (same `ch.sessionId` key the legacy client used).
import { fetchJson, postJson, randomUuid } from "./api.js";

const LS_SESSION = "ch.sessionId";

function readStoredSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION);
  } catch {
    return null;
  }
}

let sessionId: string | null = $state(readStoredSession());

/** Reactive read: track this inside any `$effect` that needs rebinding. */
export function getSessionId(): string | null {
  return sessionId;
}

/**
 * Single write path: updates the reactive value AND the durable localStorage
 * mirror (null clears it). ChatPage calls this for boot/switch/new; panels
 * only read.
 */
export function setSessionId(id: string | null): void {
  sessionId = id;
  try {
    if (id === null) localStorage.removeItem(LS_SESSION);
    else localStorage.setItem(LS_SESSION, id);
  } catch {
    // Storage may be unavailable (private mode): the reactive value still
    // drives this page load.
  }
}

/**
 * Boot helper for feature pages mounted WITHOUT the chat shell (direct
 * deep-links): adopt the stored session when it still exists, otherwise
 * create a fresh session and publish it. Returns the adopted/created id or
 * null when the transport failed.
 */
export async function ensureSession(): Promise<string | null> {
  const stored = getSessionId() ?? readStoredSession();
  if (stored !== null && stored.length > 0) {
    let probeStatus: number | null = null;
    try {
      probeStatus = (
        await fetchJson(
          `/api/sessions/${encodeURIComponent(stored)}/history?limit=1`,
        )
      ).status;
    } catch {
      probeStatus = null;
    }
    if (probeStatus === 200 || probeStatus === null) {
      setSessionId(stored);
      return stored;
    }
    if (probeStatus !== 404 && probeStatus !== 410) {
      setSessionId(stored);
      return stored;
    }
  }
  const created = await postJson("/api/sessions", {}, randomUuid());
  const body = (created.body ?? {}) as { sessionId?: unknown };
  if (created.status !== 201 || typeof body.sessionId !== "string") {
    return null;
  }
  setSessionId(body.sessionId);
  return body.sessionId;
}
