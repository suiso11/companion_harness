// Shared background admission (server-owned model-resource gate).
//
// Ownership: bootstrap creates exactly ONE gate and injects it into the
// memory service and the shadow worker. It admits at most ONE model-heavy
// background work unit at a time across:
// - memory post-completion extraction (`extractViaGateway`),
// - conversation-learning post-completion extraction,
// - shadow deliberation (`driveOneJob`: recall + claim + gateway call),
// - idle-owned remind cultivation drains (`runIdleDistill`).
//
// This is a CONSERVATIVE non-overlap invariant for the already-existing
// single-background-unit shape — NOT a hardware throughput choice, NOT a
// GPU capacity benchmark, and NOT a numeric operator budget: no threshold,
// no model selection, no provider/config knob, and no budget increase
// exists here. Foreground work (ordinary agent chat, explicit UI memory
// search/stage/recall, notification projection) NEVER acquires this gate
// and is never blocked by it; holding/shadow policy and the memory
// source/selection checks stay code-authoritative after every async gap.
//
// Honest limits (not covered, by design):
// - The admission check lives at the AUTOMATIC JOB execution boundary
//   (each `maintain.distill` CLI execution, whatever drain launched it —
//   completion, recovery, or idle), never around a whole drain batch:
//   explicit user-authorized manage work in the same tick always runs, even
//   while STOP closed the gate. The outbox `claimDueMemoryJobs` selection is
//   a read-only due read (no status mutation), so a skipped automatic job
//   needs no unclaim — attempts and backoff untouched, durable pending.
// - The remind CLI child may use local compute (embeddings/vectors) that
//   this process cannot observe: the gate serializes our calls INTO the
//   CLI for distill (plus every gateway call), but claims no GPU/resource
//   coverage beyond that non-overlap.
// - Notifications carry zero LLM work and never acquire the gate.
//
// Mechanics: identity-token reservation. `tryAcquire` returns a
// reservation only when the gate is open AND unheld; `release` frees the
// hold ONLY when the token still matches the current holder (a stale
// owner can never release a newer lease). Every release runs each
// registered wake AT MOST ONCE (finite single wake, no storm, no retry
// loop); held/expired targets are never revived by a release — wakes just
// re-check the existing fences. `close` (STOP/shutdown) admits nothing
// new; `shutdown` additionally clears all wakes (no DB-after-close).

/** Fixed background owner identities (diagnostic labels only). */
export const BACKGROUND_OWNER_MEMORY_EXTRACTION = "memory-extraction" as const;
export const BACKGROUND_OWNER_LEARNING_EXTRACTION =
  "learning-extraction" as const;
export const BACKGROUND_OWNER_SHADOW = "shadow" as const;
export const BACKGROUND_OWNER_MEMORY_IDLE_DISTILL =
  "memory-idle-distill" as const;
export const BACKGROUND_OWNER_AUTODISPATCH = "autodispatch" as const;
export const BACKGROUND_OWNER_REFLECT = "reflect" as const;

export type BackgroundOwner =
  | typeof BACKGROUND_OWNER_MEMORY_EXTRACTION
  | typeof BACKGROUND_OWNER_LEARNING_EXTRACTION
  | typeof BACKGROUND_OWNER_SHADOW
  | typeof BACKGROUND_OWNER_MEMORY_IDLE_DISTILL
  | typeof BACKGROUND_OWNER_AUTODISPATCH
  | typeof BACKGROUND_OWNER_REFLECT;

/** One held admission lease. Opaque outside the gate. */
export interface BackgroundReservation {
  readonly owner: BackgroundOwner;
  readonly token: number;
}

export interface BackgroundResourceGate {
  /** Admit one background unit, or null when closed/held (never waits). */
  tryAcquire(owner: BackgroundOwner): BackgroundReservation | null;
  /** Release a held lease (stale tokens are ignored, never throw). */
  release(reservation: BackgroundReservation): void;
  /** STOP/shutdown: no new admissions until `reopen`. Never throws. */
  close(): void;
  /** Resume: admit again. Never throws. */
  reopen(): void;
  readonly closed: boolean;
  /**
   * Register a finite wake invoked AT MOST ONCE per release (guarded, never
   * throws into the releaser). Returns an unsubscribe function.
   */
  onSettled(wake: () => void): () => void;
  /** Shutdown: close admission and clear all wakes. Never throws. */
  shutdown(): void;
}

export function createBackgroundResourceGate(): BackgroundResourceGate {
  let holder: BackgroundReservation | null = null;
  let nextToken = 1;
  let isClosed = false;
  const wakes = new Set<() => void>();

  function tryAcquire(owner: BackgroundOwner): BackgroundReservation | null {
    if (isClosed || holder !== null) {
      return null;
    }
    const reservation: BackgroundReservation = {
      owner,
      token: nextToken,
    };
    nextToken += 1;
    holder = reservation;
    return reservation;
  }

  function release(reservation: BackgroundReservation): void {
    if (holder === null || holder.token !== reservation.token) {
      // Stale owner (or nothing held): a previous holder can never free a
      // newer lease. No wake: no eligible work changed.
      return;
    }
    holder = null;
    // Sole finite wakeup: each registered wake runs at most once per
    // release, guarded so one throwing wake never blocks the others or
    // the releaser. Wakes re-check existing fences (foreground block,
    // claim CAS, held/expired states); nothing is auto-revived.
    for (const wake of [...wakes]) {
      try {
        wake();
      } catch {
        // Best effort: wake never breaks the releaser.
      }
    }
  }

  function close(): void {
    isClosed = true;
  }

  function reopen(): void {
    isClosed = false;
  }

  function onSettled(wake: () => void): () => void {
    wakes.add(wake);
    return () => {
      wakes.delete(wake);
    };
  }

  function shutdown(): void {
    isClosed = true;
    wakes.clear();
  }

  return {
    tryAcquire,
    release,
    close,
    reopen,
    get closed() {
      return isClosed;
    },
    onSettled,
    shutdown,
  };
}
