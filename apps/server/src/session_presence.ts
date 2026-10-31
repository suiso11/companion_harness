// In-memory "which chat session is the user looking at" registry.
//
// The spontaneous speech service should arrive where the user is, not in an
// arbitrary newest session. The chat page posts a heartbeat while visible;
// this registry keeps only the most recent timestamp per session (bounded)
// and never touches the database. A restart empties it; the next heartbeat
// (<=60s) or the latest-user-session fallback covers the gap.

export const SESSION_PRESENCE_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED = 100;

export interface SessionPresence {
  touch(sessionId: string, at?: number): void;
  /** Most recently viewed session within the TTL, or null. */
  active(at?: number): string | null;
  clear(): void;
}

export function createSessionPresence(
  options: { ttlMs?: number; now?: () => number } = {},
): SessionPresence {
  const ttlMs = Math.max(1000, options.ttlMs ?? SESSION_PRESENCE_TTL_MS);
  const now = options.now ?? (() => Date.now());
  const seen = new Map<string, number>();

  const prune = (at: number): void => {
    for (const [id, stamp] of seen) {
      if (at - stamp > ttlMs) seen.delete(id);
    }
    while (seen.size > MAX_TRACKED) {
      let oldestId: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, stamp] of seen) {
        if (stamp < oldest) {
          oldest = stamp;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      seen.delete(oldestId);
    }
  };

  return {
    touch(sessionId, at = now()) {
      if (sessionId.length === 0) return;
      seen.set(sessionId, at);
      prune(at);
    },
    active(at = now()) {
      prune(at);
      let bestId: string | null = null;
      let best = Number.NEGATIVE_INFINITY;
      for (const [id, stamp] of seen) {
        if (stamp > best) {
          best = stamp;
          bestId = id;
        }
      }
      return bestId;
    },
    clear() {
      seen.clear();
    },
  };
}
