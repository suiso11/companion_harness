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

import {
  applyRunEvent,
  claimTerminalHydration,
  INITIAL_RUN_VIEW,
  isCorruptCursor,
  type RunViewState,
  runResultToAnswerParts,
} from "./reducer.js";

const LS_SESSION = "ch.sessionId";
const LS_PENDING_KEY = "ch.pendingKey";
const cursorKey = (runId: string): string => `ch.cursor.${runId}`;

/**
 * History DTO (exact contracts `HistoryItem`): `{ items, nextBefore,
 * hasMore }`; each item is a Turn plus its selected completed Run's durable
 * `RunResult` (V1 `{version,text}` / V2 `{version,text,answer}`) or null.
 */
interface HistoryItemView {
  readonly turnId: string;
  readonly text: string;
  readonly selectedRun: {
    readonly runId: string;
    readonly result: unknown;
  } | null;
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
    await this.recoverPending();
    await this.hydrateHistory();
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
   * key was kept. Accepted keys replay status/body + refresh history;
   * unknown keys show a fixed resend-required prompt (never recreated).
   */
  private async recoverPending(): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    let key: string | null = null;
    try {
      key = localStorage.getItem(LS_PENDING_KEY);
    } catch {
      key = null;
    }
    if (key === null || key.length === 0) {
      return;
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
      return;
    }
    // Transient server states retain the pending key for same-key replay.
    if (
      lookup.status === 429 ||
      lookup.status === 503 ||
      lookup.status >= 500
    ) {
      this.showNotice("送信できませんでした。もう一度お試しください");
      return;
    }
    const body = lookup.body as {
      found?: unknown;
      body?: { turnId?: unknown; run?: { id?: unknown } };
    };
    if (lookup.status === 200 && body.found === true) {
      this.clearPendingKey();
      await this.hydrateHistory();
      // Exact contracts `PostMessageResponse`: `{ turnId, run: { id } }`.
      const storedRun = body.body?.run;
      const runId =
        typeof storedRun === "object" && storedRun !== null
          ? (storedRun as { id?: unknown }).id
          : null;
      const turnId =
        typeof body.body?.turnId === "string" ? body.body.turnId : null;
      if (typeof runId === "string") {
        if (turnId !== null) {
          this.runTurns.set(runId, turnId);
        }
        this.subscribe(runId);
      }
      return;
    }
    this.clearPendingKey();
    this.showNotice("送信を再入力してください");
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
        this.renderTurn(items[itemIndex] as HistoryItemView);
      }
    }
    this.renderOlderButton();
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
          const node = this.buildTurn(items[itemIndex] as HistoryItemView);
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

  private renderTurn(item: HistoryItemView): void {
    this.list.appendChild(this.buildTurn(item));
  }

  private buildTurn(item: HistoryItemView): HTMLElement {
    const wrap = el("section");
    wrap.appendChild(el("p", typeof item.text === "string" ? item.text : ""));
    const run = item.selectedRun;
    if (run !== null && run !== undefined && typeof run === "object") {
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
    const posted = await postJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/runs/${encodeURIComponent(this.activeRunId)}/cancel`,
      {},
      null,
    );
    if (posted.status < 200 || posted.status >= 300) {
      this.showNotice("停止できませんでした");
    }
    // 2xx: the run.cancel_requested event (stream or fallback poll) renders
    // the「停止しました」notice and keeps the run active until terminal.
  }

  /** Failure-only retry (§16.6 exact): failed/abandoned views only. */
  private async retry(turnId: string): Promise<void> {
    if (this.sessionId === null || this.activeRunId !== null) {
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
      void this.pollFallback(runId, stored ?? 0);
      return;
    }
    const source = this.sse;
    // JSON status fallback (§16.7): poll when SSE never establishes.
    this.fallbackTimer = window.setTimeout(() => {
      if (!opened) {
        this.closeStream();
        void this.pollFallback(runId, readStoredCursor(runId) ?? 0);
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
    // server's last issued seq, so drop it and rebuild from history.
    if (isCorruptCursor(cursor, run.eventSeq)) {
      await this.resyncFromHistory(runId);
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
    const link = this.runChain.catch(() => {}).then(async () => {
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
   */
  private static readonly POLL_INTERVAL_MS = 1000;
  private static readonly POLL_MAX_ERROR_STREAK = 5;

  private async pollFallback(runId: string, after: number): Promise<void> {
    let errorStreak = 0;
    for (;;) {
      if (this.activeRunId !== runId) {
        return;
      }
      let ok = false;
      try {
        ok = await this.catchUp(runId, readStoredCursor(runId) ?? after);
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
        void this.hydrateHistory();
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
          if (retryVisible && turnId !== null && turnId !== undefined) {
            const retryButton = el("button", "もう一度送る");
            retryButton.addEventListener("click", () => {
              void this.retry(turnId);
            });
            this.list.appendChild(retryButton);
          }
        });
      }
      return;
    }
    if (view.visible === "stopped") {
      this.showNotice("停止しました");
      this.finishActiveRun();
      // Single owner: claim the terminal hydration; a second observer of
      // the same terminal view skips it.
      if (claimTerminalHydration(this.terminalHydrated, runId)) {
        void this.hydrateHistory();
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
    this.sendButton.disabled = busy;
    this.input.disabled = false;
    this.stopButton.hidden = !busy;
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
