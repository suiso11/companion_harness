// M3 vanilla conversation client (plan §16.1, §16.2, §16.4, §16.6, §16.7).
//
// DOM API only: no framework, no UI library, no state layer beyond the
// per-run reducer (`reducer.ts`, bundled by esbuild). No `innerHTML` anywhere:
// every user/model/snapshot string is rendered via `textContent` (§16.5).
//
// Browser persistence is minimal (§16.2 exact): sessionId, per-run Run
// cursors (seq), and the pending (unanswered) Idempotency-Key only. Bodies,
// snapshots, and model/tool state are never stored.

/// <reference lib="dom" />

import type { ActiveStatus } from "@companion/contracts";
import {
  ACTION_PROGRESS_TEXT,
  type ActionCardModel,
  type ActionErrorCode,
  actionCardModel,
  actionDecisionIntentText,
  actionErrorCodeText,
  applyRunEvent,
  claimTerminalHydration,
  type ExecutionStatus,
  INITIAL_RUN_VIEW,
  isCorruptCursor,
  isRetryableTurnKind,
  type ProposalStatus,
  parseCancelRunStatus,
  type ReceiptOutcome,
  type RunViewState,
  runResultToAnswerParts,
} from "./reducer.js";

const LS_SESSION = "ch.sessionId";
const LS_PENDING_KEY = "ch.pendingKey";
/**
 * C22 approve idempotency metadata: the ONLY approval-related thing kept in
 * browser storage, exactly like the message pending key — one Idempotency-Key
 * per proposal (technical metadata). Conversation text, preview content,
 * proposal hashes, receipts, and any raw ids are NEVER persisted: the key
 * alone lets a reload replay the same approve request safely (same scope,
 * same `{ proposalHash }` body) without storing the body.
 */
const approveKeyStorageKey = (proposalId: string): string =>
  `ch.pendingApprovalKey.${proposalId}`;
const cursorKey = (runId: string): string => `ch.cursor.${runId}`;
/**
 * Active statuses for discovery gating: compile-time anchored to the
 * contracts `ActiveStatus` union (type-only import, so the browser bundle
 * never pulls zod at runtime); membership matches contracts
 * `isActiveStatus`. The server already validates discovery responses
 * against `ActiveRunResponseSchema`, so this is a best-effort client gate.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<ActiveStatus> = new Set([
  "queued",
  "running",
  "cancel_requested",
]);

/**
 * History DTO (exact contracts `HistoryItem`): `{ items, nextBefore,
 * hasMore }`. `user_text` carries the selected completed Run's durable
 * `RunResult` or null; `action_approval` carries the ACTUAL owned Action
 * execution/receipt projection independent of `turn_selections` (T1):
 * completed runs carry their persisted ID-free result with the fresh rN
 * citation, terminal non-completed runs carry `result: null` with the
 * actual receipt, and active runs carry `receipt: null` with live
 * statuses (frozen intent + progress, never a fake failure).
 */
interface HistoryItemView {
  readonly turnId: string;
  readonly kind?: string;
  readonly text?: string;
  readonly selectedRun: {
    readonly runId: string;
    readonly attempt?: number;
    readonly runStatus?: string;
    readonly finishedAt?: number | null;
    readonly result: unknown;
    readonly receipt?: {
      readonly outcome?: ReceiptOutcome;
      readonly summary?: { readonly summary?: string };
    } | null;
    readonly executionStatus?: string | null;
  } | null;
}

/**
 * C22 session-scoped proposal summary read from the ACTUAL
 * `GET /api/sessions/:id/proposals` response (exact contracts
 * `ProposalSummary`). Structural, immutable content plus mutable decision
 * state; no provider ids ever appear here.
 */
interface ProposalSummaryView {
  readonly proposalId: string;
  readonly tool: string;
  readonly input: { readonly start: string; readonly end: string };
  readonly preview: { readonly summary: string };
  readonly hash: string;
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resolvedAt: number | null;
}

/** Exact `GET .../proposals/:id/execution` view (contracts). */
interface ProposalExecutionView {
  readonly proposalId: string;
  readonly proposalStatus: ProposalStatus;
  readonly runId: string | null;
  readonly status: ExecutionStatus | null;
  readonly markerCommitted: boolean;
  readonly cancellable: boolean;
  readonly errorCode: ActionErrorCode | null;
  readonly receipt: {
    readonly outcome: ReceiptOutcome;
    readonly summary: { readonly summary: string };
    readonly createdAt: number;
  } | null;
}

/**
 * One rendered approval card. The immutable `proposalHash` is captured once
 * at build time and every control binds THAT hash — the card never
 * re-derives the hash from any other source.
 */
interface ActionCard {
  readonly proposalId: string;
  readonly hash: string;
  readonly node: HTMLElement;
  readonly progress: HTMLElement;
  readonly outcome: HTMLElement;
  readonly approve: HTMLButtonElement;
  readonly reject: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  runId: string | null;
  /** Terminal execution observed: the card is final and stops polling. */
  terminal: boolean;
}

/**
 * Action execution Stop state for ONE run, read from the ACTUAL
 * `GET .../proposals/:id/execution` view (never localStorage, never a raw
 * value). The generic composer consults this so a reloaded page never
 * offers its ordinary Stop for an Action run that is already past the
 * committed external-call marker (or terminal): only a live, pre-marker,
 * cancellable Action execution keeps the composer Stop.
 */
interface ActionRunStopState {
  readonly markerCommitted: boolean;
  readonly cancellable: boolean;
  readonly live: boolean;
}

/**
 * Reload recovery descriptor (§16.7): the recovered run id/turn plus the
 * discovered active status when known. `status` is `null` for an accepted
 * idempotency replay (whose stored response carries no status) and a
 * validated `ActiveStatus` for discovery; it only seeds the pre-subscription
 * UI and never drives the reducer cursor or the stored resume hint.
 */
interface RecoveryDescriptor {
  readonly runId: string;
  readonly turnId: string | null;
  readonly status: ActiveStatus | null;
}

function el(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function loadText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * T1 active-approval progress for history (no receipt yet): the actual
 * live execution stage as frozen progress text, never a fake failure.
 * Terminal/unknown stages render nothing here (the intent line already
 * carries the terminal receipt outcome, or the frozen intent when the
 * execution row itself is missing).
 */
function actionProgressText(executionStatus: string): string {
  if (
    executionStatus === "queued" ||
    executionStatus === "preflight" ||
    executionStatus === "executing"
  ) {
    return ACTION_PROGRESS_TEXT[executionStatus];
  }
  return "";
}

function readStoredCursor(runId: string): number | null {
  try {
    const raw = localStorage.getItem(cursorKey(runId));
    if (raw === null || raw.length === 0) {
      return null;
    }
    if (!/^\d+$/.test(raw.trim())) {
      return null;
    }
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function storeCursor(runId: string, cursor: number): void {
  try {
    localStorage.setItem(cursorKey(runId), String(cursor));
  } catch {
    // Best effort: a missing store only loses resume position.
  }
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function postJson(
  path: string,
  payload: unknown,
  key: string | null,
): Promise<{ status: number; body: unknown }> {
  return fetchJson(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key !== null ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Structural guard for one `ProposalSummary` read from the ACTUAL list API:
 * every field the card binds must have its exact expected primitive type, so
 * a malformed body renders nothing rather than a partial card.
 */
function isProposalSummary(value: unknown): value is ProposalSummaryView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as {
    proposalId?: unknown;
    tool?: unknown;
    input?: { start?: unknown; end?: unknown };
    preview?: { summary?: unknown };
    hash?: unknown;
    status?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
    resolvedAt?: unknown;
  };
  return (
    typeof item.proposalId === "string" &&
    item.tool === "calendar.reschedule" &&
    typeof item.input?.start === "string" &&
    typeof item.input?.end === "string" &&
    typeof item.preview?.summary === "string" &&
    typeof item.hash === "string" &&
    (item.status === "pending" ||
      item.status === "approved" ||
      item.status === "rejected" ||
      item.status === "expired") &&
    typeof item.createdAt === "number" &&
    typeof item.expiresAt === "number" &&
    (item.resolvedAt === null || typeof item.resolvedAt === "number")
  );
}

/** Plain-text local timestamp for the deadline line (no technical ids). */
function formatInstant(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

class ConversationApp {
  private sessionId: string | null = null;
  private activeRunId: string | null = null;
  private activeTurnId: string | null = null;
  /**
   * Frozen pending request (§16.7 exact): the idempotency key AND the
   * complete normalized body (text + the uiContext snapshot fetched once at
   * submit time) are frozen in memory together. Every replay of the same
   * key carries the identical body — refetching the reference context on
   * resend would change the body hash and break the §9 replay contract.
   * In memory only: bodies are never persisted to localStorage.
   */
  private pendingRequest: {
    readonly key: string;
    readonly text: string;
    uiContext: unknown;
  } | null = null;
  private runChain: Promise<void> = Promise.resolve();
  private runViews = new Map<string, RunViewState>();
  /** Runs whose terminal answer was already rendered (no duplicate output). */
  private readonly renderedAnswers = new Set<string>();
  /**
   * Runs whose terminal history refresh was already claimed (single owner,
   * §16.7): the serialized event path and the fallback poll path can both
   * observe the same terminal view, but hydration (and the retry appended
   * after it) must happen exactly once so a second refresh never wipes it.
   */
  private readonly terminalHydrated = new Set<string>();
  /**
   * Client-side send bound (mirrors contracts `MAX_USER_TEXT_LENGTH`):
   * overlong input is rejected locally with a validation notice and never
   * frozen/posted. The server schema stays authoritative.
   */
  private static readonly MAX_SEND_TEXT_LENGTH = 32_768;
  /** True while a send/post round-trip is awaited (send stays disabled). */
  private sending = false;
  /** Run -> Turn ownership for failure-only retry (§16.6 exact). */
  private readonly runTurns = new Map<string, string>();
  /**
   * Turn -> history `kind` (`user_text` / `action_approval` /
   * `action_rejection`), hydrated from the ACTUAL history projection.
   * The failure-only retry control is offered only for `user_text` Turns
   * (§18.4/§18.6): decision Turns never re-execute through the generic
   * retry, so their failed/abandoned Action runs render no retry control.
   */
  private readonly turnKinds = new Map<string, string>();
  private sse: EventSource | null = null;
  private fallbackTimer: number | null = null;

  private readonly list: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly drawerBody: HTMLElement;

  constructor() {
    this.list = document.getElementById("conversation") ?? el("main");
    this.notice = document.getElementById("composer-notice") ?? el("p");
    this.form =
      (document.getElementById("composer") as HTMLFormElement | null) ??
      document.createElement("form");
    this.input =
      (document.getElementById("composer-input") as HTMLInputElement | null) ??
      document.createElement("input");
    this.sendButton =
      (document.getElementById("composer-send") as HTMLButtonElement | null) ??
      document.createElement("button");
    this.stopButton =
      (document.getElementById("composer-stop") as HTMLButtonElement | null) ??
      document.createElement("button");
    this.drawer = document.getElementById("drawer") ?? el("div");
    this.drawerBody = document.getElementById("drawer-body") ?? el("pre");
  }

  async boot(): Promise<void> {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.send();
    });
    this.stopButton.addEventListener("click", () => {
      void this.stop();
    });
    this.drawer.addEventListener("click", (event) => {
      if (event.target === this.drawer) {
        this.closeDrawer();
      }
    });
    await this.ensureSession();
    let descriptor = await this.recoverPending();
    if (descriptor === null) {
      descriptor = await this.discoverActiveRun();
    }
    // Mark the recovered run active and render the busy composer BEFORE the
    // final history hydration: a held/slow hydration must never expose an
    // enabled Send for a genuinely active Run (§16.3/§16.7). A discovered
    // non-terminal `cancel_requested` status also seeds its「停止しました」
    // notice here (reducer cursor 0, never the discovery `eventSeq`). The
    // actual SSE subscription stays deferred until after hydration so the
    // durable history (and its terminal dedup anchor) is registered first.
    if (descriptor !== null) {
      this.activeRunId = descriptor.runId;
      this.activeTurnId = descriptor.turnId;
      if (descriptor.turnId !== null) {
        this.runTurns.set(descriptor.runId, descriptor.turnId);
      }
      this.seedActiveView(descriptor.runId, descriptor.status);
      // A reload can adopt an m5-action Run as the generic active run. Read
      // its ACTUAL execution marker/cancellability BEFORE the first composer
      // paint so a post-marker (or terminal) Action never offers Stop.
      await this.refreshActionRunStops();
      this.renderComposer();
    }
    // One final hydration owned by boot: durable history renders first so a
    // completed selected Run is registered in renderedAnswers BEFORE any
    // subscription replays its terminal — a captured-active reload that
    // races completion can never append a second answer.
    await this.hydrateHistory();
    // C22: read the actual pending proposals/executions after the durable
    // history so a reload restores a still-pending approval card (and its
    // real progress/receipt) without ever persisting proposal content.
    this.scheduleActionSync();
    // The captured run id is subscribed exactly once, even when the run has
    // already completed meanwhile: the durable event backlog renders or
    // dedups, and the terminal view releases the composer normally.
    if (descriptor !== null) {
      this.subscribe(descriptor.runId);
    }
    this.renderComposer();
  }

  /** Auto session init (§16.2): reuse the stored id, else POST /api/sessions. */
  private async ensureSession(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LS_SESSION);
    } catch {
      stored = null;
    }
    if (stored !== null && stored.length > 0) {
      let probeStatus: number | null = null;
      try {
        const check = await fetchJson(
          `/api/sessions/${encodeURIComponent(stored)}/history?limit=1`,
        );
        probeStatus = check.status;
      } catch {
        probeStatus = null;
      }
      if (probeStatus === 200) {
        this.sessionId = stored;
        return;
      }
      // Replace the stored session only on a definitive miss (unknown id).
      // Transient probe failures (network/5xx/429) keep the stored id so a
      // healthy session is never orphaned by a blip.
      if (probeStatus === 404 || probeStatus === 410) {
        try {
          localStorage.removeItem(LS_SESSION);
        } catch {
          // Best effort.
        }
      } else if (probeStatus !== null) {
        this.sessionId = stored;
        return;
      } else {
        // Network-level probe failure: keep the stored id for retry.
        this.sessionId = stored;
        return;
      }
    }
    const key = crypto.randomUUID();
    const created = await postJson("/api/sessions", {}, key);
    const body = created.body as { sessionId?: unknown };
    if (created.status !== 201 || typeof body.sessionId !== "string") {
      this.showNotice("セッションを開始できませんでした");
      return;
    }
    this.sessionId = body.sessionId;
    try {
      localStorage.setItem(LS_SESSION, body.sessionId);
    } catch {
      // Best effort.
    }
  }

  /**
   * Reload recovery without stored bodies (§16.7 exact): only the pending
   * key was kept. Accepted keys are cleared here and produce a run/turn
   * descriptor for the caller (boot owns exactly one history hydration and
   * one subscription); unknown keys show a fixed resend-required prompt
   * (never recreated). Retention on transient failures keeps the key.
   */
  private async recoverPending(): Promise<RecoveryDescriptor | null> {
    if (this.sessionId === null) {
      return null;
    }
    let key: string | null = null;
    try {
      key = localStorage.getItem(LS_PENDING_KEY);
    } catch {
      key = null;
    }
    if (key === null || key.length === 0) {
      return null;
    }
    const scope = `session:${this.sessionId}:message`;
    let lookup: { status: number; body: unknown };
    try {
      lookup = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/idempotency/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`,
      );
    } catch {
      // Transient network failure: retain the pending key for a later retry.
      this.showNotice("送信できませんでした。もう一度お試しください");
      return null;
    }
    // Transient server states retain the pending key for same-key replay.
    if (
      lookup.status === 429 ||
      lookup.status === 503 ||
      lookup.status >= 500
    ) {
      this.showNotice("送信できませんでした。もう一度お試しください");
      return null;
    }
    const body = lookup.body as {
      found?: unknown;
      body?: { turnId?: unknown; run?: { id?: unknown } };
    };
    if (lookup.status === 200 && body.found === true) {
      this.clearPendingKey();
      // Exact contracts `PostMessageResponse`: `{ turnId, run: { id } }`.
      const storedRun = body.body?.run;
      const runId =
        typeof storedRun === "object" && storedRun !== null
          ? (storedRun as { id?: unknown }).id
          : null;
      const turnId =
        typeof body.body?.turnId === "string" ? body.body.turnId : null;
      if (typeof runId === "string") {
        // The stored idempotency response carries no status; the accepted
        // run is seeded only by live events/status after subscription.
        return { runId, turnId, status: null };
      }
      return null;
    }
    this.clearPendingKey();
    this.showNotice("送信を再入力してください");
    return null;
  }

  /**
   * Active-run discovery for the accepted-202 reload (§16.7): the minimal
   * additive `GET /api/sessions/:sessionId/active-run` read. A discovered
   * active run yields a `{runId, turnId}` descriptor the caller maps and
   * subscribes exactly once, even if the run completed meanwhile (durable
   * history plus the existing status/events/SSE pipeline cover the
   * terminal). A 404 session or a known session without an active run
   * (200 `{run:null}`) yields none. The stream cursor is never initialized
   * from the discovery `eventSeq`: the stored per-run cursor stays the
   * resume authority.
   */
  private async discoverActiveRun(): Promise<RecoveryDescriptor | null> {
    if (this.sessionId === null) {
      return null;
    }
    let discovered: { status: number; body: unknown };
    try {
      discovered = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/active-run`,
      );
    } catch {
      return null;
    }
    if (discovered.status !== 200) {
      return null;
    }
    const run = (discovered.body as { run?: unknown }).run;
    const status =
      typeof run === "object" && run !== null
        ? (run as { status?: unknown }).status
        : null;
    const runId =
      typeof run === "object" && run !== null
        ? (run as { id?: unknown }).id
        : null;
    const turnId =
      typeof run === "object" && run !== null
        ? (run as { turnId?: unknown }).turnId
        : null;
    if (
      typeof runId !== "string" ||
      typeof status !== "string" ||
      !ACTIVE_RUN_STATUSES.has(status as ActiveStatus)
    ) {
      return null;
    }
    return {
      runId,
      turnId: typeof turnId === "string" ? turnId : null,
      status: status as ActiveStatus,
    };
  }

  /**
   * Seed a pre-subscription view for a discovered active Run (§16.7): a
   * non-terminal `cancel_requested` Run must already render its
   * 「停止しました」notice — Send disabled, Stop visible, input enabled —
   * before the stream opens. The reducer cursor stays 0: the discovery
   * `eventSeq` is never applied as a fabricated event and the stored resume
   * cursor is never advanced from the snapshot. The real events/catch-up/
   * status pipeline remains the authoritative terminal, and `subscribe`
   * preserves this seeded view (`runViews` already holds the run).
   * Unknown/optional statuses seed nothing.
   */
  private seedActiveView(runId: string, status: ActiveStatus | null): void {
    if (status !== "cancel_requested") {
      return;
    }
    const seeded: RunViewState = {
      ...INITIAL_RUN_VIEW,
      notice: "停止しました",
    };
    this.runViews.set(runId, seeded);
    this.showNotice(seeded.notice);
  }

  /**
   * History hydration (§16.6 exact): paged via hasMore/nextBefore so older
   * turns stay reachable, chronological render (oldest first). The initial
   * pass is bounded to 20 pages x 50 items; when older turns remain, an
   * explicit "older history" control loads them incrementally (never
   * silently dropped). Every fetch is same-origin JSON, no bodies stored.
   */
  private oldestBefore: number | null = null;
  private historyHasMore = false;
  private loadingOlder = false;

  /**
   * Record the ACTUAL history `kind` for a Turn so the failure-only retry
   * gate can tell a `user_text` Turn from an M5 decision Turn (§18.4).
   * The gate itself fails closed: only a recorded `user_text` kind ever
   * enables the control.
   */
  private trackTurnKind(item: HistoryItemView): void {
    if (
      typeof item.turnId === "string" &&
      item.turnId.length > 0 &&
      typeof item.kind === "string" &&
      item.kind.length > 0
    ) {
      this.turnKinds.set(item.turnId, item.kind);
    }
  }

  private async hydrateHistory(): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const sessionId = this.sessionId;
    const pages: HistoryItemView[][] = [];
    let before: number | null = null;
    let capped: { before: number } | null = null;
    for (let round = 0; round < 20; round += 1) {
      const query =
        before === null
          ? `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=50`
          : `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=50&beforePosition=${before}`;
      let page: { status: number; body: unknown };
      try {
        page = await fetchJson(query);
      } catch {
        return;
      }
      if (page.status !== 200) {
        return;
      }
      const body = page.body as {
        items?: unknown;
        nextBefore?: unknown;
        hasMore?: unknown;
      };
      if (!Array.isArray(body.items)) {
        return;
      }
      pages.push(body.items as HistoryItemView[]);
      if (body.hasMore !== true || typeof body.nextBefore !== "number") {
        before = null;
        break;
      }
      before = body.nextBefore;
      if (round === 19) {
        capped = { before };
      }
    }
    this.oldestBefore = capped !== null ? capped.before : null;
    this.historyHasMore = capped !== null;
    this.list.replaceChildren();
    // Server pages arrive latest-first but items within each page are
    // already chronological (oldest first); render oldest-first overall.
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      const items = (pages[index] ?? []) as HistoryItemView[];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex] as HistoryItemView;
        this.trackTurnKind(item);
        this.renderTurn(item);
      }
    }
    this.renderOlderButton();
    // Action cards are live DOM nodes owned by THIS client, and the history
    // rebuild above replaces the whole list. Re-attach every still-live card
    // (appendChild MOVES the node, so its rendered state — including a
    // terminal receipt — survives). Without this a card rendered after the
    // rebuild would be invisible while still present in actionCards.
    for (const card of this.actionCards.values()) {
      this.list.appendChild(card.node);
    }
  }

  /**
   * Bounded incremental older-history loading: the 20-page cap never
   * silently drops access — the control fetches the next (up to 20) older
   * pages and prepends them chronologically. Plain button, no send queue
   * interaction (§16.3: submit path untouched).
   */
  private async loadOlderHistory(): Promise<void> {
    if (
      this.sessionId === null ||
      this.oldestBefore === null ||
      this.loadingOlder
    ) {
      return;
    }
    this.loadingOlder = true;
    try {
      const sessionId = this.sessionId;
      const pages: HistoryItemView[][] = [];
      let before: number | null = this.oldestBefore;
      for (let round = 0; round < 20 && before !== null; round += 1) {
        let page: { status: number; body: unknown };
        try {
          page = await fetchJson(
            `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=50&beforePosition=${before}`,
          );
        } catch {
          return;
        }
        if (
          page.status !== 200 ||
          !Array.isArray((page.body as { items?: unknown }).items)
        ) {
          return;
        }
        const body = page.body as {
          items?: unknown;
          nextBefore?: unknown;
          hasMore?: unknown;
        };
        pages.push(body.items as HistoryItemView[]);
        if (body.hasMore === true && typeof body.nextBefore === "number") {
          before = body.nextBefore;
        } else {
          before = null;
        }
      }
      this.oldestBefore = before;
      this.historyHasMore = before !== null;
      // Prepend oldest-first: oldest page first, items forward within a page.
      const anchor = this.list.firstChild;
      for (let index = pages.length - 1; index >= 0; index -= 1) {
        const items = (pages[index] ?? []) as HistoryItemView[];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const item = items[itemIndex] as HistoryItemView;
          this.trackTurnKind(item);
          const node = this.buildTurn(item);
          this.list.insertBefore(node, anchor);
        }
      }
    } finally {
      this.loadingOlder = false;
      this.renderOlderButton();
    }
  }

  private renderOlderButton(): void {
    const existing = document.getElementById("history-older");
    if (existing !== null) {
      existing.remove();
    }
    if (!this.historyHasMore || this.oldestBefore === null) {
      return;
    }
    const button = document.createElement("button");
    button.textContent = "さらに古い履歴を読み込む";
    button.id = "history-older";
    button.disabled = this.loadingOlder;
    button.addEventListener("click", () => {
      void this.loadOlderHistory();
    });
    this.list.prepend(button);
  }

  /* ---------------------------------------------------------------- */
  /* C22 actual approval UX: proposals, execution status, receipts      */
  /* ---------------------------------------------------------------- */

  private readonly actionCards = new Map<string, ActionCard>();
  private actionSync: Promise<void> | null = null;
  /**
   * Actual Action execution Stop state by run id (`GET .../execution`
   * reads only). Lets the generic composer hide/disable its Stop for a
   * post-marker or terminal Action run adopted on reload, while an
   * ordinary Run (no entry here) keeps the unchanged Stop behaviour.
   */
  private readonly actionRunStops = new Map<string, ActionRunStopState>();
  private static readonly ACTION_POLL_INTERVAL_MS = 1000;
  /** Bounded execution watch (proposal TTL is exactly 15 minutes). */
  private static readonly ACTION_POLL_MAX_TICKS = 16 * 60;

  /**
   * Serialized action sync (§18.4 reads): exactly one proposals +
   * execution/receipt refresh at a time, so a card is never rendered from a
   * half-updated read. Called after boot hydration, after a decision, and
   * after a run terminal.
   */
  private scheduleActionSync(): void {
    if (this.actionSync !== null) {
      return;
    }
    const run = this.syncActions().finally(() => {
      this.actionSync = null;
    });
    this.actionSync = run.catch(() => {});
  }

  /**
   * Read the ACTUAL session proposals and each approved proposal's actual
   * execution status + receipt. A pending, unexpired proposal renders one
   * approval card; a decided/expired one renders no card (its deterministic
   * intent and receipt come from the history projection).
   */
  private async syncActions(): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const sessionId = this.sessionId;
    let listed: { status: number; body: unknown };
    try {
      listed = await fetchJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/proposals`,
      );
    } catch {
      return;
    }
    if (listed.status !== 200 || this.sessionId !== sessionId) {
      return;
    }
    const proposals = (listed.body as { proposals?: unknown }).proposals;
    if (!Array.isArray(proposals)) {
      return;
    }
    const now = Date.now();
    const summaries = proposals.filter((item): item is ProposalSummaryView =>
      isProposalSummary(item),
    );
    // Drop cards whose proposal is no longer actionable/visible.
    const liveIds = new Set(summaries.map((item) => item.proposalId));
    for (const proposalId of [...this.actionCards.keys()]) {
      if (!liveIds.has(proposalId)) {
        this.removeActionCard(proposalId);
      }
    }
    for (const summary of summaries) {
      if (summary.status === "pending" && summary.expiresAt > now) {
        this.ensureActionCard(summary);
      }
    }
    // Execution + receipt reads for every decided/approved proposal.
    for (const summary of summaries) {
      if (summary.status === "pending") {
        continue;
      }
      await this.syncExecution(summary);
    }
  }

  /** Read the ACTUAL execution status + receipt and update/retire a card. */
  private async syncExecution(summary: ProposalSummaryView): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    let fetched: { status: number; body: unknown };
    try {
      fetched = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/proposals/${encodeURIComponent(summary.proposalId)}/execution`,
      );
    } catch {
      return;
    }
    if (fetched.status !== 200) {
      return;
    }
    const view = fetched.body as ProposalExecutionView;
    if (typeof view.proposalId !== "string") {
      return;
    }
    // Every execution read refreshes the composer Stop routing for the
    // owning run, so a marker that commits while the page lives hides the
    // generic Stop without a reload.
    this.trackActionExecutionView(view);
    // The execution read is the AUTHORITATIVE proposal state: a watch started
    // from the pre-approval (still `pending`) summary must never keep
    // rendering a decided/executed proposal as an actionable pending card.
    const actual: ProposalSummaryView =
      typeof view.proposalStatus === "string"
        ? { ...summary, status: view.proposalStatus }
        : summary;
    const terminal =
      view.receipt !== null && view.receipt !== undefined
        ? true
        : view.status !== null &&
          view.status !== "queued" &&
          view.status !== "preflight" &&
          view.status !== "executing";
    const card = this.actionCards.get(view.proposalId);
    if (terminal && view.status !== null) {
      // Terminal: the REAL receipt (or the real fixed failure text) is
      // rendered ON the card the user was already looking at — the approval
      // card is never retired before the outcome is shown, so a succeeded
      // execution always ends on a visible verified receipt and every other
      // terminal on its real failure text. The deterministic decision intent
      // and the fresh result citation additionally come from the history
      // projection. No card (e.g. after a reload): nothing to render.
      this.clearApproveKey(view.proposalId);
      if (card !== undefined) {
        card.runId = view.runId ?? card.runId;
        card.terminal = true;
        this.renderActionCard(
          card,
          actual,
          view,
          this.cardModel(actual, view),
          actionErrorCodeText(view.errorCode ?? null),
        );
      }
      await this.hydrateHistory();
      return;
    }
    if (card === undefined) {
      return;
    }
    card.runId = view.runId ?? card.runId;
    this.renderActionCard(
      card,
      actual,
      view,
      this.cardModel(actual, view),
      actionErrorCodeText(view.errorCode ?? null),
    );
    if (
      view.status !== null &&
      (view.status === "queued" ||
        view.status === "preflight" ||
        view.status === "executing")
    ) {
      this.watchAction(view.proposalId, summary);
    }
  }

  /**
   * Record the ACTUAL execution Stop state for the owning run (read-only,
   * no DOM). The generic composer Stop consults this entry: a live,
   * pre-marker, cancellable Action execution keeps the composer Stop, while
   * a committed marker, a refused cancellability, or a terminal execution
   * hides/disables it. Runs without an entry are ordinary Runs with the
   * unchanged Stop behaviour.
   */
  private trackActionExecutionView(view: ProposalExecutionView): void {
    if (view.runId === null) {
      return;
    }
    const live =
      view.status === "queued" ||
      view.status === "preflight" ||
      view.status === "executing";
    this.actionRunStops.set(view.runId, {
      markerCommitted: view.markerCommitted === true,
      cancellable: view.cancellable === true,
      live,
    });
    this.renderComposer();
  }

  /**
   * Read-only refresh of every decided proposal's ACTUAL execution Stop
   * state through the existing proposals/execution APIs (no DOM, no card
   * side effects). Boot awaits this before the first composer paint so a
   * reloaded post-marker Action cannot offer Stop even briefly.
   */
  private async refreshActionRunStops(): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const sessionId = this.sessionId;
    let listed: { status: number; body: unknown };
    try {
      listed = await fetchJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/proposals`,
      );
    } catch {
      return;
    }
    if (listed.status !== 200 || this.sessionId !== sessionId) {
      return;
    }
    const proposals = (listed.body as { proposals?: unknown }).proposals;
    if (!Array.isArray(proposals)) {
      return;
    }
    for (const item of proposals) {
      if (!isProposalSummary(item) || item.status === "pending") {
        continue;
      }
      let fetched: { status: number; body: unknown };
      try {
        fetched = await fetchJson(
          `/api/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(item.proposalId)}/execution`,
        );
      } catch {
        continue;
      }
      if (fetched.status !== 200 || this.sessionId !== sessionId) {
        continue;
      }
      const view = fetched.body as ProposalExecutionView;
      if (typeof view.proposalId !== "string") {
        continue;
      }
      this.trackActionExecutionView(view);
    }
  }

  /**
   * True when the run is a KNOWN Action execution whose generic composer
   * Stop must stay hidden/disabled (committed marker, refused
   * cancellability, or terminal execution). Unknown runs (ordinary Runs,
   * or an Action not yet read) are never blocked here.
   */
  private isActionStopBlocked(runId: string): boolean {
    const state = this.actionRunStops.get(runId);
    if (state === undefined) {
      return false;
    }
    return !state.live || state.markerCommitted || !state.cancellable;
  }

  /** Pure card model for the actual API reads plus the client clock. */
  private cardModel(
    summary: ProposalSummaryView,
    view: ProposalExecutionView | null,
  ): ActionCardModel {
    return actionCardModel({
      status: summary.status,
      preview: summary.preview.summary,
      start: summary.input.start,
      end: summary.input.end,
      expiresAt: summary.expiresAt,
      now: Date.now(),
      executionStatus: view?.status ?? null,
      markerCommitted: view?.markerCommitted ?? false,
      cancellable: view?.cancellable ?? false,
      receiptOutcome: view?.receipt?.outcome ?? null,
      receiptSummary: view?.receipt?.summary.summary ?? null,
    });
  }

  /**
   * Build (once) the approval card for a pending, unexpired proposal. Every
   * string is set with `textContent` (escaped plain text, never HTML) and
   * carries NO technical id: preview, target event, start/end, and the
   * server deadline only.
   */
  private ensureActionCard(summary: ProposalSummaryView): void {
    const existing = this.actionCards.get(summary.proposalId);
    if (existing !== undefined) {
      this.renderActionCard(
        existing,
        summary,
        null,
        this.cardModel(summary, null),
        "",
      );
      return;
    }
    const node = el("section");
    node.id = `action-card-${summary.proposalId}`;
    node.setAttribute("data-action-card", "true");
    node.setAttribute("data-action-tool", summary.tool);
    node.appendChild(el("h3", "日程変更の確認"));
    const preview = el("p", summary.preview.summary);
    preview.setAttribute("data-action-preview", "true");
    node.appendChild(preview);
    const startLine = el("p", `開始: ${summary.input.start}`);
    startLine.setAttribute("data-action-start", "true");
    node.appendChild(startLine);
    const endLine = el("p", `終了: ${summary.input.end}`);
    endLine.setAttribute("data-action-end", "true");
    node.appendChild(endLine);
    const deadline = el("p", `確認期限: ${formatInstant(summary.expiresAt)}`);
    deadline.setAttribute("data-action-deadline", "true");
    node.appendChild(deadline);
    const progress = el("p");
    progress.setAttribute("data-action-progress", "true");
    node.appendChild(progress);
    const outcome = el("p");
    outcome.setAttribute("data-action-outcome", "true");
    node.appendChild(outcome);
    const approve = document.createElement("button");
    approve.textContent = "承認";
    approve.type = "button";
    approve.id = "action-approve";
    approve.setAttribute("data-action-approve", "true");
    node.appendChild(approve);
    const reject = document.createElement("button");
    reject.textContent = "却下";
    reject.type = "button";
    reject.id = "action-reject";
    reject.setAttribute("data-action-reject", "true");
    node.appendChild(reject);
    const stop = document.createElement("button");
    stop.textContent = "中断";
    stop.type = "button";
    stop.hidden = true;
    stop.setAttribute("data-action-stop", "true");
    node.appendChild(stop);
    const card: ActionCard = {
      proposalId: summary.proposalId,
      hash: summary.hash,
      node,
      progress,
      outcome,
      approve,
      reject,
      stop,
      runId: null,
      terminal: false,
    };
    approve.addEventListener("click", () => {
      void this.approve(card);
    });
    reject.addEventListener("click", () => {
      void this.reject(card);
    });
    stop.addEventListener("click", () => {
      void this.stopAction(card);
    });
    this.actionCards.set(summary.proposalId, card);
    this.list.appendChild(node);
    this.renderActionCard(
      card,
      summary,
      null,
      this.cardModel(summary, null),
      "",
    );
  }

  /** Apply the pure model to the live card nodes (no HTML, text only). */
  private renderActionCard(
    card: ActionCard,
    summary: ProposalSummaryView,
    view: ProposalExecutionView | null,
    model: ActionCardModel,
    errorText: string,
  ): void {
    card.node.setAttribute(
      "data-action-state",
      model.expired
        ? "expired"
        : summary.status === "pending"
          ? "pending"
          : (view?.status ?? summary.status),
    );
    card.progress.textContent = model.progressText;
    const outcomeText =
      model.outcomeText !== "" ? model.outcomeText : errorText;
    card.outcome.textContent = outcomeText;
    card.approve.hidden = !model.decisionVisible;
    card.reject.hidden = !model.decisionVisible;
    card.approve.disabled = !model.decisionVisible;
    card.reject.disabled = !model.decisionVisible;
    // Contextual Stop: only a live execution BEFORE the committed external
    // marker. After the marker (or terminal) it is hidden and disabled — the
    // write can no longer be safely cancelled.
    card.stop.hidden = !model.stopVisible;
    card.stop.disabled = !model.stopVisible;
    card.node.setAttribute(
      "data-action-marker",
      view?.markerCommitted === true ? "committed" : "uncommitted",
    );
  }

  private removeActionCard(proposalId: string): void {
    const card = this.actionCards.get(proposalId);
    if (card === undefined) {
      return;
    }
    card.node.remove();
    this.actionCards.delete(proposalId);
  }

  /**
   * Approve: binds the card's IMMUTABLE `proposalHash`, sends a body of
   * exactly `{ proposalHash }`, and carries a STABLE Idempotency-Key (kept
   * as technical metadata only) so a retry after a reload replays the same
   * request instead of approving twice.
   *
   * Before the POST the ACTUAL server repository state is re-read: a
   * proposal that is no longer `pending`/`unexpired` is never executed from
   * a stale card.
   */
  private async approve(card: ActionCard): Promise<void> {
    if (this.sessionId === null || card.approve.disabled) {
      return;
    }
    const sessionId = this.sessionId;
    let current: ProposalSummaryView | null = null;
    try {
      const listed = await fetchJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/proposals`,
      );
      const items = (listed.body as { proposals?: unknown }).proposals;
      if (listed.status === 200 && Array.isArray(items)) {
        current =
          (items as unknown[]).find(
            (item): item is ProposalSummaryView =>
              isProposalSummary(item) && item.proposalId === card.proposalId,
          ) ?? null;
      }
    } catch {
      current = null;
    }
    if (
      current === null ||
      current.status !== "pending" ||
      current.hash !== card.hash ||
      current.expiresAt <= Date.now()
    ) {
      this.showNotice("この変更は承認できません。内容を確認してください");
      this.removeActionCard(card.proposalId);
      this.scheduleActionSync();
      return;
    }
    const key = this.approveKey(card.proposalId);
    card.approve.disabled = true;
    card.reject.disabled = true;
    let posted: { status: number; body: unknown };
    try {
      posted = await postJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(card.proposalId)}/approve`,
        { proposalHash: card.hash },
        key,
      );
    } catch {
      // Transient: the SAME key + SAME body are replayed on the next click.
      this.showNotice("承認できませんでした。もう一度お試しください");
      this.scheduleActionSync();
      return;
    }
    if (posted.status === 202) {
      // Accepted: the key has served its purpose (the decision is durable).
      this.clearApproveKey(card.proposalId);
      const body = posted.body as { runId?: unknown };
      if (typeof body.runId === "string") {
        card.runId = body.runId;
      }
      this.showNotice("承認しました");
      void this.watchAction(card.proposalId, current);
      return;
    }
    // Definitive 4xx (state conflict / disabled / hash mismatch): drop the
    // key and re-read the real state; nothing was executed.
    if (posted.status === 409) {
      this.clearApproveKey(card.proposalId);
      this.showNotice("この変更は承認できません。内容を確認してください");
      await this.hydrateHistory();
      this.scheduleActionSync();
      return;
    }
    this.showNotice("承認できませんでした。もう一度お試しください");
    this.scheduleActionSync();
  }

  /** Reject: KEYLESS by contract — no Idempotency-Key is ever sent. */
  private async reject(card: ActionCard): Promise<void> {
    if (this.sessionId === null || card.reject.disabled) {
      return;
    }
    const posted = await postJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/proposals/${encodeURIComponent(card.proposalId)}/reject`,
      { proposalHash: card.hash },
      null,
    );
    if (posted.status === 200) {
      this.clearApproveKey(card.proposalId);
      this.showNotice("却下しました");
      this.removeActionCard(card.proposalId);
      await this.hydrateHistory();
      return;
    }
    this.showNotice("却下できませんでした。内容を確認してください");
    this.scheduleActionSync();
  }

  /**
   * Contextual Stop for a live Action execution. Only offered before the
   * committed external-call marker. The `200` body carries the ACTUAL
   * resulting run status: the「停止しました」notice is shown ONLY when the
   * run terminalised `cancelled`. Any other `200` (a `cancel_requested`
   * accept, or a terminal `completed`/`failed`/`abandoned` that won the
   * race) refreshes the ACTUAL receipt/execution and claims nothing; a
   * `409` (`action_not_cancellable`, marker committed) or any other
   * outcome re-reads the actual execution state instead of faking a stop
   * or an unknown success.
   */
  private async stopAction(card: ActionCard): Promise<void> {
    if (this.sessionId === null || card.runId === null || card.stop.disabled) {
      return;
    }
    card.stop.disabled = true;
    let posted: { status: number; body: unknown };
    try {
      posted = await postJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/runs/${encodeURIComponent(card.runId)}/cancel`,
        {},
        null,
      );
    } catch {
      // Transport failure: nothing was cancelled — re-offer Stop and
      // re-read the actual state instead of claiming anything.
      card.stop.disabled = false;
      this.showNotice("停止できませんでした");
      this.scheduleActionSync();
      return;
    }
    if (posted.status === 200) {
      if (parseCancelRunStatus(posted.body) === "cancelled") {
        this.showNotice("停止しました");
        this.scheduleActionSync();
        return;
      }
      // Accepted but NOT a cancelled terminal: never claim a stop —
      // refresh the ACTUAL receipt/execution view instead.
      card.stop.disabled = false;
      this.scheduleActionSync();
      return;
    }
    // 409 `action_not_cancellable` (marker committed) or any other
    // non-2xx: re-read the ACTUAL execution view instead of guessing.
    card.stop.disabled = false;
    this.scheduleActionSync();
  }

  /**
   * Bounded execution watch: polls the ACTUAL execution + receipt view until
   * the execution is terminal. Never posts anything — read-only progress
   * (queued / preflight / executing → real receipt).
   */
  private async watchAction(
    proposalId: string,
    summary: ProposalSummaryView,
  ): Promise<void> {
    const existing = this.actionWatches.get(proposalId);
    if (existing !== undefined) {
      return;
    }
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.actionWatches.set(proposalId, done);
    try {
      for (
        let tick = 0;
        tick < ConversationApp.ACTION_POLL_MAX_TICKS;
        tick += 1
      ) {
        const card = this.actionCards.get(proposalId);
        if (card === undefined || card.terminal) {
          return;
        }
        await this.syncExecution(summary);
        if (!this.actionCards.has(proposalId)) {
          return;
        }
        await new Promise((resolve) => {
          window.setTimeout(resolve, ConversationApp.ACTION_POLL_INTERVAL_MS);
        });
      }
    } finally {
      this.actionWatches.delete(proposalId);
      resolveDone();
    }
  }

  private readonly actionWatches = new Map<string, Promise<void>>();

  /** Stable per-proposal Idempotency-Key: metadata only, never a body. */
  private approveKey(proposalId: string): string {
    try {
      const stored = localStorage.getItem(approveKeyStorageKey(proposalId));
      if (stored !== null && stored.length > 0) {
        return stored;
      }
    } catch {
      // Fall through to a fresh key.
    }
    const key = crypto.randomUUID();
    try {
      localStorage.setItem(approveKeyStorageKey(proposalId), key);
    } catch {
      // Best effort: the in-page retry reuses the same frozen request.
    }
    return key;
  }

  private clearApproveKey(proposalId: string): void {
    try {
      localStorage.removeItem(approveKeyStorageKey(proposalId));
    } catch {
      // Best effort.
    }
  }

  private renderTurn(item: HistoryItemView): void {
    this.list.appendChild(this.buildTurn(item));
  }

  private buildTurn(item: HistoryItemView): HTMLElement {
    const wrap = el("section");
    // T1: the two exact decision variants carry NO user text — render the
    // deterministic intent derived from the real persisted decision plus the
    // ACTUAL receipt (terminal, incl. failed/unknown/cancelled/abandoned and
    // recovered) or the live progress for an active approval (never a blank
    // line, never a fake failure, never a "stopped" claim for a write that
    // left the process). The outcome renders in ONE form (the intent line);
    // the receipt summary renders once below it; result part TEXT is not
    // re-rendered (it would duplicate the outcome/summary) — only its fresh
    // rN citations are kept as buttons.
    if (item.kind === "action_approval" || item.kind === "action_rejection") {
      const receipt = item.selectedRun?.receipt ?? null;
      const outcome =
        receipt !== null && typeof receipt.outcome === "string"
          ? receipt.outcome
          : null;
      wrap.setAttribute("data-action-history", item.kind);
      wrap.appendChild(el("p", actionDecisionIntentText(item.kind, outcome)));
      const run = item.selectedRun;
      if (run !== null && run !== undefined && typeof run === "object") {
        // Durable dedup anchor: EVERY projected Action run id (incl. a
        // receipt-only terminal with `result: null`) registers here, so a
        // captured-active reload whose later subscription/SSE replays that
        // same terminal never appends it twice (`renderRunView`). Internal
        // ids live only in this set + DOM metadata, never in visible text.
        if (typeof run.runId === "string" && run.runId.length > 0) {
          this.renderedAnswers.add(run.runId);
          wrap.setAttribute("data-action-run", run.runId);
        }
        const rawSummary =
          receipt !== null &&
          typeof receipt.summary === "object" &&
          receipt.summary !== null
            ? (receipt.summary as { summary?: unknown }).summary
            : null;
        if (typeof rawSummary === "string" && rawSummary.length > 0) {
          // Display-only tool-prefix strip (stored preview contract
          // unchanged): the deterministic staged preview carries a
          // `calendar.reschedule: ` prefix that must never reach visible
          // text (T6); the stored `summary_json` keeps it.
          const displaySummary = rawSummary.startsWith("calendar.reschedule:")
            ? rawSummary.slice("calendar.reschedule:".length).trim()
            : rawSummary;
          if (displaySummary.length > 0) {
            const line = el("p", displaySummary);
            line.setAttribute("data-action-receipt", "true");
            wrap.appendChild(line);
          }
        } else if (
          receipt === null &&
          typeof run.executionStatus === "string"
        ) {
          // Active approval with no terminal receipt: actual progress, never
          // a fabricated failure.
          const progress = actionProgressText(run.executionStatus);
          if (progress.length > 0) {
            const line = el("p", progress);
            line.setAttribute("data-action-progress", "true");
            wrap.appendChild(line);
          }
        }
        // Citations only (no duplicated outcome/summary text): the verified
        // fresh rN survives reloads with no extra external call.
        if (run.result !== null && run.result !== undefined) {
          for (const part of runResultToAnswerParts(run.result)) {
            for (const citation of part.citations) {
              const button = el("button", citation);
              button.setAttribute("data-action-citation", "true");
              button.addEventListener("click", () => {
                void this.openCitation(citation);
              });
              wrap.appendChild(button);
            }
          }
        }
      }
      return wrap;
    }
    wrap.appendChild(el("p", typeof item.text === "string" ? item.text : ""));
    const run = item.selectedRun;
    if (run !== null && run !== undefined && typeof run === "object") {
      // Durable terminal dedup anchor: a completed selected Run id is
      // registered the moment history renders it, so a captured-active
      // reload whose later subscription replays that same terminal answer
      // is guarded against appending it twice (`renderRunView`).
      if (typeof run.runId === "string" && run.runId.length > 0) {
        this.renderedAnswers.add(run.runId);
      }
      // Completed selected Run: V2 answer parts with citations, or the V1
      // rendered text without citations (runResultToAnswerParts handles both).
      for (const part of runResultToAnswerParts(run.result)) {
        wrap.appendChild(el("p", part.text));
        for (const citation of part.citations) {
          const button = el("button", citation);
          button.addEventListener("click", () => {
            void this.openCitation(citation);
          });
          wrap.appendChild(button);
        }
      }
    } else {
      // No selected completed Run: failed/cancelled/abandoned Runs never
      // appear in the history projection; retry is offered by the live view.
      wrap.appendChild(el("p", "応答なし"));
    }
    return wrap;
  }

  /**
   * Reference-context snapshot (§14.8 CAS): fetched exactly once per send
   * and frozen into the pending request. Missing/unreadable context sends
   * the default `{}` (never blocks sending).
   */
  private async fetchUiContext(): Promise<unknown> {
    if (this.sessionId === null) {
      return {};
    }
    try {
      const context = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/reference-context`,
      );
      const contextBody = context.body as {
        version?: unknown;
        items?: unknown;
      };
      if (
        context.status === 200 &&
        typeof contextBody.version === "number" &&
        Array.isArray(contextBody.items)
      ) {
        return {
          referenceContext: {
            version: contextBody.version,
            items: contextBody.items,
          },
        };
      }
    } catch {
      // Fall through to the default empty context.
    }
    return {};
  }

  /**
   * Optimistic send (§16.2): reflect immediately, resend the SAME frozen
   * key + normalized body while the page lives (server replays key +
   * request, §9). A fresh send freezes `{ key, text, uiContext }` before
   * posting; an explicit resend reuses that frozen request as-is.
   */
  private async send(): Promise<void> {
    if (this.sessionId === null || this.activeRunId !== null || this.sending) {
      return;
    }
    if (this.pendingRequest === null) {
      const text = this.input.value;
      if (text.trim().length === 0) {
        return;
      }
      if (text.length > ConversationApp.MAX_SEND_TEXT_LENGTH) {
        this.showNotice("入力を確認してください");
        this.renderComposer();
        return;
      }
      const request = {
        key: crypto.randomUUID(),
        text,
        uiContext: {} as unknown,
      };
      this.pendingRequest = request;
      this.list.appendChild(el("p", text));
      this.input.value = "";
      this.sending = true;
      this.renderComposer();
      try {
        // Freeze the context snapshot into the SAME request before posting;
        // resends never refetch it (frozen body + key, §16.7 exact).
        request.uiContext = await this.fetchUiContext();
      } finally {
        this.sending = false;
        this.renderComposer();
      }
    }
    const request = this.pendingRequest;
    if (request === null) {
      return;
    }
    try {
      localStorage.setItem(LS_PENDING_KEY, request.key);
    } catch {
      // Best effort.
    }
    this.sending = true;
    this.renderComposer();
    let posted: { status: number; body: unknown };
    try {
      posted = await postJson(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/messages`,
        { text: request.text, uiContext: request.uiContext },
        request.key,
      );
    } catch {
      // Network failure: retryable notice, same frozen key/body kept both in
      // memory and in localStorage for explicit same-key replay.
      this.sending = false;
      this.showNotice("送信できませんでした。もう一度お試しください");
      this.renderComposer();
      return;
    }
    this.sending = false;
    // Exact contracts `PostMessageResponse`: `{ turnId, run: { id } }`.
    const body = posted.body as {
      turnId?: unknown;
      run?: { id?: unknown };
    };
    const run = body.run;
    const runId =
      typeof run === "object" && run !== null
        ? (run as { id?: unknown }).id
        : null;
    if (
      posted.status === 202 &&
      typeof body.turnId === "string" &&
      typeof runId === "string"
    ) {
      this.clearPendingKey();
      this.activeTurnId = body.turnId;
      this.runTurns.set(runId, body.turnId);
      // A fresh send always creates a `user_text` Turn (§12.2), so the
      // failure-only retry gate knows its kind even before hydration.
      this.turnKinds.set(body.turnId, "user_text");
      this.subscribe(runId);
      return;
    }
    const errorCode =
      typeof posted.body === "object" && posted.body !== null
        ? (posted.body as { error?: { code?: unknown } }).error?.code
        : undefined;
    // Retryable busy: the frozen key/body was never accepted, so keep the
    // same frozen request for an explicit same-key replay once free.
    if (posted.status === 409 && errorCode === "session_busy") {
      this.showNotice("生成中のため送信できません");
      this.renderComposer();
      await this.hydrateHistory();
      return;
    }
    // Definitive client rejection (validation/ownership/unknown, including
    // overlong text): replaying the same frozen body would fail forever, so
    // drop the frozen request/key, repopulate the input from memory (bodies
    // are never persisted), and show a validation notice. Transient states
    // (429/5xx/network) keep the frozen same-key replay below.
    if (
      posted.status >= 400 &&
      posted.status < 500 &&
      posted.status !== 408 &&
      posted.status !== 425 &&
      posted.status !== 429
    ) {
      const frozenText = request.text;
      this.clearPendingKey();
      this.input.value = frozenText;
      this.showNotice("入力を確認してください");
      this.renderComposer();
      return;
    }
    // Transient (validation/transient): keep the frozen in-memory key/body
    // for an explicit same-key resend; the notice invites a retry.
    this.showNotice("送信できませんでした。もう一度お試しください");
    this.renderComposer();
  }

  /**
   * Explicit resend with the frozen in-memory request (same page only,
   * §16.7 exact): identical key AND identical body — the reference context
   * is never refetched, so the §9 replay hash stays stable.
   */
  async resend(): Promise<void> {
    if (this.pendingRequest === null) {
      return;
    }
    await this.send();
  }

  /**
   * Contextual stop (§16.6 exact): only while a run is active. Posting the
   * cancel does NOT finish the run — `run.cancel_requested` keeps the run
   * active (stream open, submit disabled, stop visible) while displaying
   *「停止しました」; only the terminal `run.cancelled` event releases it.
   */
  private async stop(): Promise<void> {
    if (this.sessionId === null || this.activeRunId === null) {
      return;
    }
    // A post-marker (or terminal) Action run adopted on reload must never
    // be cancelled from the generic composer: re-read the actual state and
    // leave the composer Stop hidden/disabled instead of posting.
    if (this.isActionStopBlocked(this.activeRunId)) {
      await this.refreshActionRunStops();
      this.renderComposer();
      return;
    }
    const posted = await postJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/runs/${encodeURIComponent(this.activeRunId)}/cancel`,
      {},
      null,
    );
    if (posted.status < 200 || posted.status >= 300) {
      this.showNotice("停止できませんでした");
      return;
    }
    // An adopted LIVE Action execution reports its ACTUAL resulting run
    // status in the 200 body: only a `cancelled` terminal may claim the
    // stop here — any other outcome re-reads the actual execution state
    // instead (the true `run.cancelled` terminal event, when it arrives,
    // still renders the notice through the ordinary stream path).
    if (this.actionRunStops.has(this.activeRunId)) {
      if (parseCancelRunStatus(posted.body) === "cancelled") {
        this.showNotice("停止しました");
      }
      await this.refreshActionRunStops();
      this.scheduleActionSync();
      this.renderComposer();
      return;
    }
    // 2xx: the run.cancel_requested event (stream or fallback poll) renders
    // the「停止しました」notice and keeps the run active until terminal.
  }

  /**
   * Failure-only retry (§16.6 exact): failed/abandoned views only, and
   * `user_text` Turns only (§18.4/§18.6). A decision Turn is never posted:
   * the server denies it with `400 validation_error`, so a locally known
   * decision Turn is refused here with the same fixed notice as a denied
   * retry instead of a wasted request.
   */
  private async retry(turnId: string): Promise<void> {
    if (this.sessionId === null || this.activeRunId !== null) {
      return;
    }
    if (!isRetryableTurnKind(this.turnKinds.get(turnId))) {
      this.showNotice("再試行できませんでした");
      return;
    }
    const key = crypto.randomUUID();
    const posted = await postJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/turns/${encodeURIComponent(turnId)}/retries`,
      {},
      key,
    );
    // Exact contracts `PostRetryResponse` (= `PostMessageResponse`):
    // `{ turnId, run: { id } }`.
    const body = posted.body as {
      turnId?: unknown;
      run?: { id?: unknown };
    };
    const run = body.run;
    const runId =
      typeof run === "object" && run !== null
        ? (run as { id?: unknown }).id
        : null;
    if (posted.status === 202 && typeof runId === "string") {
      this.activeTurnId = turnId;
      this.runTurns.set(runId, turnId);
      // A retried Turn is always `user_text` (the guard above + the server
      // contract), so the next failure can offer the control again.
      this.turnKinds.set(turnId, "user_text");
      this.subscribe(runId);
      return;
    }
    this.showNotice("再試行できませんでした");
  }

  /** Per-run serialized subscription (§16.4 exact) with gap catch-up. */
  private subscribe(runId: string): void {
    if (this.sessionId === null) {
      return;
    }
    this.closeStream();
    this.activeRunId = runId;
    if (!this.runViews.has(runId)) {
      this.runViews.set(runId, INITIAL_RUN_VIEW);
    }
    this.renderComposer();
    const sessionId = this.sessionId;
    const stored = readStoredCursor(runId);
    // Corrupt-cursor guard at subscribe time: a syntactically valid but
    // impossible cursor (validated against the server eventSeq below) must
    // resync from history instead of opening a stream that can never
    // converge. Validation is async; the stream opens with a safe cursor
    // (0 when corrupt) and resync replaces it once confirmed.
    void this.validateStoredCursor(runId, stored ?? 0);
    const query = stored !== null && stored > 0 ? `?after=${stored}` : "";
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events/stream${query}`;
    let opened = false;
    try {
      this.sse = new EventSource(url);
    } catch {
      this.sse = null;
    }
    if (this.sse === null) {
      void this.pollFallback(runId);
      return;
    }
    const source = this.sse;
    // JSON status fallback (§16.7): poll when SSE never establishes.
    this.fallbackTimer = window.setTimeout(() => {
      if (!opened) {
        this.closeStream();
        void this.pollFallback(runId);
      }
    }, 5000);
    source.addEventListener("run-event", (message) => {
      opened = true;
      const raw = (message as MessageEvent).data;
      let event: { seq?: unknown; type?: unknown; payload?: unknown } | null =
        null;
      try {
        event = JSON.parse(loadText(raw)) as {
          seq?: unknown;
          type?: unknown;
          payload?: unknown;
        };
      } catch {
        event = null;
      }
      if (
        event === null ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
      ) {
        return;
      }
      this.applySerialized(runId, {
        seq: event.seq,
        type: event.type,
        payload: event.payload,
      });
    });
    source.onerror = () => {
      // Native EventSource auto-reconnects with Last-Event-ID (§16.7);
      // a closed terminal stream arrives as an error after completion.
      // Only a terminal view releases the run (never a bare disconnect —
      // the Run is durable and must not be cancelled on stream loss), and
      // only for the still-subscribed run so a newer run is never dropped.
      if (this.activeRunId !== runId) {
        return;
      }
      const view = this.runViews.get(runId);
      if (
        view !== undefined &&
        (view.visible === "answered" ||
          view.visible === "failed" ||
          view.visible === "stopped")
      ) {
        this.finishActiveRun();
      }
    };
  }

  /**
   * Validate a stored cursor against the authoritative `runs.event_seq`
   * (§16.7): the lightweight run status endpoint carries the server's
   * `eventSeq`, so an over-large cursor is detected on ACTIVE runs too. The
   * events page can never serve this: an empty page echoes the request
   * `after` as `nextAfter`, making the over-large cursor invisible there —
   * never infer corruption from `nextAfter`. Only acts on the
   * still-subscribed run.
   */
  private async validateStoredCursor(
    runId: string,
    cursor: number,
  ): Promise<void> {
    if (this.sessionId === null || cursor <= 0 || this.activeRunId !== runId) {
      return;
    }
    let fetched: { status: number; body: unknown };
    try {
      fetched = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId as string)}/runs/${encodeURIComponent(runId)}/status`,
      );
    } catch {
      return;
    }
    if (this.activeRunId !== runId || fetched.status !== 200) {
      return;
    }
    const run = (
      fetched.body as {
        run?: { id?: unknown; status?: unknown; eventSeq?: unknown };
      }
    ).run;
    if (
      typeof run !== "object" ||
      run === null ||
      run.id !== runId ||
      typeof run.eventSeq !== "number"
    ) {
      return;
    }
    // Authoritative check: the stored cursor can never converge past the
    // server's last issued seq, so drop it and rebuild from history, then
    // re-subscribe the still-live run with a safe cursor so the durable run
    // still completes and renders (resync alone would orphan it: history at
    // resync time cannot contain the in-flight answer). The re-subscribed
    // validation is a no-op (cursor now null), so no infinite loop.
    if (isCorruptCursor(cursor, run.eventSeq)) {
      await this.resyncFromHistory(runId);
      if (this.sessionId !== null) {
        this.subscribe(runId);
      }
    }
  }

  /** Serialized reducer application; cursor persisted only after apply. */
  private applySerialized(
    runId: string,
    event: { seq: number; type: string; payload: unknown },
  ): void {
    // A rejected predecessor must never wedge the chain permanently: every
    // link absorbs the previous rejection before appending its own step,
    // and every step catches its own failure.
    const absorbed = this.runChain.catch(() => {});
    const link = absorbed.then(async () => {
      try {
        const current = this.runViews.get(runId) ?? INITIAL_RUN_VIEW;
        const applied = applyRunEvent(current, event);
        if (applied.outcome.kind === "ignored-duplicate") {
          // Duplicates: cursor unchanged, no store write, no re-render, so
          // terminal output is never appended twice.
          return;
        }
        if (applied.outcome.kind === "ignored-unknown") {
          // Unknown/future types already advanced the cursor: persist it
          // but do not re-render (no output to duplicate).
          this.runViews.set(runId, applied.state);
          storeCursor(runId, applied.state.cursor);
          return;
        }
        if (applied.outcome.kind === "needs-catchup") {
          const ok = await this.catchUp(runId, current.cursor);
          if (!ok) {
            // Transient page failure: keep the chain alive; the next tick
            // (SSE event or fallback poll) retries the gap.
            return;
          }
          const resynced = this.runViews.get(runId) ?? INITIAL_RUN_VIEW;
          const second = applyRunEvent(resynced, event);
          if (second.outcome.kind === "needs-catchup") {
            // The stored cursor never converges with the server stream (e.g.
            // corrupted beyond `event_seq`, §16.7): stop reconnecting and
            // resync from history instead.
            await this.resyncFromHistory(runId);
            return;
          }
          if (second.outcome.kind === "ignored-duplicate") {
            // The triggering SSE frame was already applied via the JSON
            // gap page (e.g. dropped seq bridged by catch-up): the terminal
            // view is converged but never rendered on the catch-up path,
            // so render it here (exactly-once guarded).
            this.renderRunView(runId);
            return;
          }
          if (second.outcome.kind === "ignored-unknown") {
            this.runViews.set(runId, second.state);
            storeCursor(runId, second.state.cursor);
            return;
          }
          // Catch-up converged: the re-applied event is applied, so persist
          // the cursor after apply.
          this.runViews.set(runId, second.state);
          storeCursor(runId, second.state.cursor);
          this.renderRunView(runId);
          return;
        }
        this.runViews.set(runId, applied.state);
        storeCursor(runId, applied.state.cursor);
        this.renderRunView(runId);
      } catch {
        // One bad tick (I/O, DOM) must never wedge later events.
      }
    });
    // The chain itself never stays rejected: a failure above already
    // resolved, and this guard absorbs out-of-band rejections.
    this.runChain = link.catch(() => {});
  }

  /**
   * Gap catch-up via the M0 JSON pagination API (§16.4 exact). Returns true
   * when the page fetch succeeded (even with zero events); false on any
   * transport or non-2xx failure so callers count it as a failure.
   */
  private async catchUp(runId: string, after: number): Promise<boolean> {
    if (this.sessionId === null) {
      return true;
    }
    let cursor = after;
    for (let page = 0; page < 20; page += 1) {
      let fetched: { status: number; body: unknown };
      try {
        fetched = await fetchJson(
          `/api/sessions/${encodeURIComponent(this.sessionId as string)}/runs/${encodeURIComponent(runId)}/events?after=${cursor}&limit=50`,
        );
      } catch {
        return false;
      }
      // Every non-2xx page is a failure (counted by the caller); only 2xx
      // with a well-formed event array advances the view.
      if (fetched.status < 200 || fetched.status >= 300) {
        return false;
      }
      const body = fetched.body as {
        events?: Array<{ seq?: unknown; type?: unknown; payload?: unknown }>;
        nextAfter?: unknown;
        terminal?: unknown;
      };
      if (!Array.isArray(body.events)) {
        return false;
      }
      for (const item of body.events) {
        if (typeof item.seq !== "number" || typeof item.type !== "string") {
          continue;
        }
        const current = this.runViews.get(runId) ?? INITIAL_RUN_VIEW;
        const applied = applyRunEvent(current, {
          seq: item.seq,
          type: item.type,
          payload: item.payload,
        });
        if (applied.outcome.kind === "needs-catchup") {
          return true;
        }
        // Duplicates from overlapping pages: advance nothing, render
        // nothing; unknown types only advance the stored cursor.
        if (applied.outcome.kind === "ignored-duplicate") {
          continue;
        }
        this.runViews.set(runId, applied.state);
        storeCursor(runId, applied.state.cursor);
      }
      cursor = typeof body.nextAfter === "number" ? body.nextAfter : cursor + 1;
      if (body.events.length === 0) {
        return true;
      }
    }
    return true;
  }

  /**
   * JSON status fallback poll (§16.7): events + history. Bounded SEQUENTIAL
   * polling with no tick cap: runs until the run is terminal or the client
   * disposes the run (new run subscribed / resync). Long runs are never
   * stranded. Transient fetch failures are absorbed (bounded consecutive
   * error streak before giving up with a fixed notice; each success resets
   * the streak). This path never cancels the Run.
   *
   * Catch-up always starts from the IN-MEMORY reducer cursor of the run
   * view, never from the persisted per-run cursor: after a reload the
   * reducer view is `INITIAL_RUN_VIEW` (cursor 0) while the stored cursor
   * (e.g. 2) is only the SSE resume hint — starting the JSON replay from
   * the stored hint would leave the reducer stuck in a gap at cursor 0
   * (queued/started never applied) and the run would never converge to
   * its terminal. Replaying from the reducer cursor is safe mid-stream too:
   * durable events at or below the reducer cursor are reducer dedups
   * (no double render), and the persisted store still advances only after
   * each apply.
   */
  private static readonly POLL_INTERVAL_MS = 1000;
  private static readonly POLL_MAX_ERROR_STREAK = 5;

  private async pollFallback(runId: string): Promise<void> {
    let errorStreak = 0;
    for (;;) {
      if (this.activeRunId !== runId) {
        return;
      }
      let ok = false;
      try {
        const view = this.runViews.get(runId);
        ok = await this.catchUp(runId, view?.cursor ?? 0);
      } catch {
        ok = false;
      }
      // Non-2xx/transport failures count toward the bounded streak; only a
      // successful page resets it.
      if (!ok) {
        errorStreak += 1;
        if (errorStreak >= ConversationApp.POLL_MAX_ERROR_STREAK) {
          this.showNotice("状態の取得に失敗しました。再読み込みしてください");
          return;
        }
      } else {
        errorStreak = 0;
      }
      if (this.activeRunId !== runId) {
        return;
      }
      this.renderRunView(runId);
      const view = this.runViews.get(runId);
      if (view !== undefined && !view.stopVisible) {
        // Terminal (`run.completed`/`failed`/`cancelled`/`abandoned`):
        // `run.cancel_requested` keeps stopVisible true, so polling
        // continues until the actual terminal event. renderRunView already
        // claimed the single terminal hydration (history refresh, retry
        // appended after it for failures) — hydrating again here would wipe
        // the retry, so just release the poll loop.
        this.finishActiveRun();
        return;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, ConversationApp.POLL_INTERVAL_MS);
      });
    }
  }

  private renderRunView(runId: string): void {
    const view = this.runViews.get(runId);
    if (view === undefined) {
      return;
    }
    if (view.visible === "answered") {
      // Render each terminal answer exactly once: duplicates re-drive this
      // path via the serialized chain, so guard with renderedAnswers instead
      // of appending the same paragraphs/buttons again.
      if (this.renderedAnswers.has(runId)) {
        this.finishActiveRun();
        // T1 follow-up: the durable history already rendered this terminal
        // (e.g. an approval reloaded while queued/preflight/executing whose
        // decided proposal has no card, so no watch drives the update). The
        // answer itself must NOT append twice — but the single-owner
        // terminal refresh still runs so the receipt + fresh citation land
        // without a second reload.
        if (claimTerminalHydration(this.terminalHydrated, runId)) {
          void this.hydrateHistory().then(() => {
            this.scheduleActionSync();
          });
        }
        return;
      }
      this.renderedAnswers.add(runId);
      for (const part of view.answer) {
        this.list.appendChild(el("p", part.text));
        for (const citation of part.citations) {
          const button = el("button", citation);
          button.addEventListener("click", () => {
            void this.openCitation(citation);
          });
          this.list.appendChild(button);
        }
      }
      this.finishActiveRun();
      // Single owner: claim the terminal hydration; a second observer of
      // the same terminal view skips it so output is never duplicated.
      if (claimTerminalHydration(this.terminalHydrated, runId)) {
        void this.hydrateHistory().then(() => {
          this.scheduleActionSync();
        });
      }
      return;
    }
    if (view.visible === "failed") {
      this.showNotice("生成に失敗しました");
      // Failure-only retry (§16.6 exact): offer one retry for the same Turn
      // (a fresh Run). Capture the Turn before finishActiveRun clears it.
      // The retry control must survive the history refresh below, so hydrate
      // first and append the button afterwards. Single owner: claim the
      // terminal hydration so a second observer never wipes the retry.
      const turnId = this.runTurns.get(runId) ?? this.activeTurnId;
      const retryVisible = view.retryVisible;
      this.finishActiveRun();
      if (claimTerminalHydration(this.terminalHydrated, runId)) {
        void this.hydrateHistory().then(() => {
          // M5 decision-turn denial (§18.4/§18.6): the retry control is
          // appended only for `user_text` Turns. Hydration above refreshed
          // the Turn kinds, so a failed/abandoned Action run renders its
          // actual receipt from history with no retry control here.
          if (
            retryVisible &&
            turnId !== null &&
            turnId !== undefined &&
            isRetryableTurnKind(this.turnKinds.get(turnId))
          ) {
            const retryButton = el("button", "もう一度送る");
            retryButton.addEventListener("click", () => {
              void this.retry(turnId);
            });
            this.list.appendChild(retryButton);
          }
          // A failed Action run still carries its actual receipt in the
          // history projection above; refresh live cards to the same real
          // terminal (no-op when no card/proposal exists).
          this.scheduleActionSync();
        });
      }
      return;
    }
    if (view.visible === "stopped") {
      this.showNotice("停止しました");
      this.finishActiveRun();
      // Single owner: claim the terminal hydration; a second observer of
      // the same terminal view skips it. Cancelled Action runs hydrate the
      // same actual receipt/cards as the failed path above.
      if (claimTerminalHydration(this.terminalHydrated, runId)) {
        void this.hydrateHistory().then(() => {
          this.scheduleActionSync();
        });
      }
      return;
    }
    // Active (generating) view: the reducer's notice drives the text, so
    // `run.cancel_requested` shows「停止しました」while the run stays active.
    this.showNotice(view.notice);
    this.renderComposer();
  }

  /**
   * Reference-context CAS update (§14.8, §16.5): opening a citation adds it
   * to the session's implicit selection via a REAL conditional PUT —
   * `{ version: expected, items }` against the stored version. A 409
   * `reference_version_conflict` re-reads the stored context and retries a
   * bounded number of times (lost-update handling); exhaustion or any other
   * failure is non-fatal (the drawer still opens).
   */
  private static readonly REFERENCE_CONTEXT_CAS_ATTEMPTS = 3;

  private async updateReferenceContextCas(referenceId: string): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const base = `/api/sessions/${encodeURIComponent(this.sessionId)}/reference-context`;
    for (
      let attempt = 0;
      attempt < ConversationApp.REFERENCE_CONTEXT_CAS_ATTEMPTS;
      attempt += 1
    ) {
      let current: { status: number; body: unknown };
      try {
        current = await fetchJson(base);
      } catch {
        return;
      }
      if (current.status !== 200) {
        return;
      }
      const stored = current.body as { version?: unknown; items?: unknown };
      if (
        typeof stored.version !== "number" ||
        !Number.isSafeInteger(stored.version) ||
        stored.version < 1 ||
        !Array.isArray(stored.items)
      ) {
        return;
      }
      const items = stored.items.filter(
        (item): item is string =>
          typeof item === "string" && item.length > 0 && item !== referenceId,
      );
      // Already selected: no CAS write needed (the PUT rejects duplicates).
      if (items.length !== stored.items.length) {
        return;
      }
      items.push(referenceId);
      let put: { status: number; body: unknown };
      try {
        put = await fetchJson(base, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: stored.version, items }),
        });
      } catch {
        return;
      }
      if (put.status >= 200 && put.status < 300) {
        return;
      }
      if (put.status !== 409) {
        return;
      }
      // Version conflict: loop re-reads the stored context and retries CAS.
    }
  }

  /** Citation drawer (§16.5): stored snapshot as escaped plain text only. */
  private async openCitation(citation: string): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/references`,
    );
    // Exact contracts `ReferenceListResponse`: `{ items: [...] }` — each
    // item carries the reference id plus its rN presentation ordinal.
    const items = (listed.body as { items?: unknown }).items;
    let referenceId: string | null = null;
    if (Array.isArray(items)) {
      for (const item of items as Array<{
        id?: unknown;
        ordinal?: unknown;
      }>) {
        const label =
          typeof item.ordinal === "number" ? `r${item.ordinal}` : null;
        if (
          (typeof item.id === "string" && item.id === citation) ||
          (label !== null && label === citation)
        ) {
          referenceId = typeof item.id === "string" ? item.id : null;
          break;
        }
      }
    }
    if (referenceId === null) {
      return;
    }
    // Open = implicit selection update (§14.8 CAS): add the reference to the
    // session reference context via a real conditional PUT before showing it.
    // Conflict/loss is non-fatal — the drawer still opens.
    await this.updateReferenceContextCas(referenceId);
    const detail = await fetchJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/references/${encodeURIComponent(referenceId)}`,
    );
    // Exact contracts `ReferenceDetailResponse`: `body` is the stored
    // `SnapshotBody` `{ version, text }` — render the text only.
    const snapshot = (detail.body as { body?: unknown }).body;
    const snapshotText =
      typeof snapshot === "object" && snapshot !== null
        ? (snapshot as { text?: unknown }).text
        : snapshot;
    this.drawerBody.textContent = loadText(snapshotText);
    this.drawer.hidden = false;
  }

  private closeDrawer(): void {
    this.drawerBody.textContent = "";
    this.drawer.hidden = true;
  }

  /** Type-while-active with submit disabled (§16.3): no message queue. */
  private renderComposer(): void {
    // Submit is disabled while a run is active AND while a send/post
    // round-trip (including the context freeze) is in flight; the input
    // itself stays enabled (§16.3 type-while-active).
    const busy = this.activeRunId !== null || this.sending;
    // An adopted Action run keeps the composer busy (Send disabled), but
    // its Stop follows the ACTUAL execution marker/cancellability: after
    // the marker (or terminal) the generic Stop is hidden AND disabled —
    // the write already left this process. Ordinary Runs are unchanged.
    const actionBlocked =
      this.activeRunId !== null && this.isActionStopBlocked(this.activeRunId);
    const stopOffered = busy && !actionBlocked;
    this.sendButton.disabled = busy;
    this.input.disabled = false;
    this.stopButton.hidden = !stopOffered;
    this.stopButton.disabled = !stopOffered;
  }

  private finishActiveRun(): void {
    this.activeRunId = null;
    this.activeTurnId = null;
    this.closeStream();
    this.renderComposer();
  }

  private closeStream(): void {
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.sse !== null) {
      try {
        this.sse.close();
      } catch {
        // Best effort.
      }
      this.sse = null;
    }
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
  }

  private clearPendingKey(): void {
    // Drops BOTH the persisted key and the frozen in-memory request: once
    // the key is accepted (or rejected as busy) no further replay happens.
    this.pendingRequest = null;
    try {
      localStorage.removeItem(LS_PENDING_KEY);
    } catch {
      // Best effort.
    }
  }

  /** Corrupt-cursor guard hook (§16.7): history resync instead of reconnect. */
  async resyncIfCorrupt(runId: string, eventSeq: number): Promise<boolean> {
    const stored = readStoredCursor(runId);
    if (stored !== null && isCorruptCursor(stored, eventSeq)) {
      await this.resyncFromHistory(runId);
      return true;
    }
    return false;
  }

  /**
   * History resync (§16.7): drop the per-run stream + view state and
   * rebuild from the history projection. Used both for explicitly corrupt
   * cursors (eventSeq from the run status endpoint) and for catch-up that
   * never converges.
   */
  private async resyncFromHistory(runId: string): Promise<void> {
    this.closeStream();
    if (this.activeRunId === runId) {
      this.activeRunId = null;
    }
    this.runViews.delete(runId);
    try {
      localStorage.removeItem(cursorKey(runId));
    } catch {
      // Best effort.
    }
    await this.hydrateHistory();
    this.renderComposer();
  }
}

export type { HistoryItemView };
export { ConversationApp };

function boot(): void {
  const app = new ConversationApp();
  document.addEventListener("DOMContentLoaded", () => {
    void app.boot();
  });
}

boot();
