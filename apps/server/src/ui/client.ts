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
    try {
      const stored = localStorage.getItem(LS_SESSION);
      if (stored !== null && stored.length > 0) {
        const check = await fetchJson(
          `/api/sessions/${encodeURIComponent(stored)}/history?limit=1`,
        );
        if (check.status === 200) {
          this.sessionId = stored;
          return;
        }
      }
    } catch {
      // Fall through to session creation.
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
    const lookup = await fetchJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/idempotency/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`,
    );
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

  /** History hydration (§16.6 exact): latest page, chronological render. */
  private async hydrateHistory(): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    const page = await fetchJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/history?limit=50`,
    );
    const items = (page.body as { items?: unknown }).items;
    this.list.replaceChildren();
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items as HistoryItemView[]) {
      this.renderTurn(item);
    }
  }

  private renderTurn(item: HistoryItemView): void {
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
    this.list.appendChild(wrap);
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
    if (this.sessionId === null || this.activeRunId !== null) {
      return;
    }
    if (this.pendingRequest === null) {
      const text = this.input.value;
      if (text.trim().length === 0) {
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
      this.renderComposer();
      // Freeze the context snapshot into the SAME request before posting;
      // resends never refetch it (frozen body + key, §16.7 exact).
      request.uiContext = await this.fetchUiContext();
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
    const posted = await postJson(
      `/api/sessions/${encodeURIComponent(this.sessionId)}/messages`,
      { text: request.text, uiContext: request.uiContext },
      request.key,
    );
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
    if (posted.status === 409) {
      this.clearPendingKey();
      this.showNotice("生成中のため送信できません");
      await this.hydrateHistory();
      return;
    }
    // No response: keep the frozen in-memory key/body for an explicit resend.
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

  /** Serialized reducer application; cursor persisted only after apply. */
  private applySerialized(
    runId: string,
    event: { seq: number; type: string; payload: unknown },
  ): void {
    this.runChain = this.runChain.then(async () => {
      const current = this.runViews.get(runId) ?? INITIAL_RUN_VIEW;
      const applied = applyRunEvent(current, event);
      if (applied.outcome.kind === "needs-catchup") {
        await this.catchUp(runId, current.cursor);
        const resynced = this.runViews.get(runId) ?? INITIAL_RUN_VIEW;
        const second = applyRunEvent(resynced, event);
        if (second.outcome.kind === "needs-catchup") {
          // The stored cursor never converges with the server stream (e.g.
          // corrupted beyond `event_seq`, §16.7): stop reconnecting and
          // resync from history instead.
          await this.resyncFromHistory(runId);
          return;
        }
        // Catch-up converged: the re-applied event is applied (or safely
        // ignored as duplicate/unknown), so persist the cursor after apply.
        this.runViews.set(runId, second.state);
        storeCursor(runId, second.state.cursor);
        this.renderRunView(runId);
        return;
      }
      this.runViews.set(runId, applied.state);
      // Unknown types already advanced the cursor inside the reducer;
      // duplicates leave it unchanged. Either way persist after apply.
      storeCursor(runId, applied.state.cursor);
      this.renderRunView(runId);
    });
  }

  /** Gap catch-up via the M0 JSON pagination API (§16.4 exact). */
  private async catchUp(runId: string, after: number): Promise<void> {
    if (this.sessionId === null) {
      return;
    }
    let cursor = after;
    for (let page = 0; page < 20; page += 1) {
      const fetched = await fetchJson(
        `/api/sessions/${encodeURIComponent(this.sessionId as string)}/runs/${encodeURIComponent(runId)}/events?after=${cursor}&limit=50`,
      );
      const body = fetched.body as {
        events?: Array<{ seq?: unknown; type?: unknown; payload?: unknown }>;
        nextAfter?: unknown;
        terminal?: unknown;
      };
      if (fetched.status !== 200 || !Array.isArray(body.events)) {
        return;
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
          return;
        }
        this.runViews.set(runId, applied.state);
        storeCursor(runId, applied.state.cursor);
      }
      cursor = typeof body.nextAfter === "number" ? body.nextAfter : cursor + 1;
      if (body.events.length === 0) {
        return;
      }
    }
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
      try {
        await this.catchUp(runId, readStoredCursor(runId) ?? after);
        errorStreak = 0;
      } catch {
        errorStreak += 1;
        if (errorStreak >= ConversationApp.POLL_MAX_ERROR_STREAK) {
          this.showNotice("状態の取得に失敗しました。再読み込みしてください");
          return;
        }
      }
      if (this.activeRunId !== runId) {
        return;
      }
      this.renderRunView(runId);
      const view = this.runViews.get(runId);
      if (view !== undefined && !view.stopVisible) {
        // Terminal (`run.completed`/`failed`/`cancelled`/`abandoned`):
        // `run.cancel_requested` keeps stopVisible true, so polling
        // continues until the actual terminal event.
        this.finishActiveRun();
        await this.hydrateHistory();
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
      return;
    }
    if (view.visible === "failed") {
      this.showNotice("生成に失敗しました");
      // Failure-only retry (§16.6 exact): offer one retry for the same Turn
      // (a fresh Run). Capture the Turn before finishActiveRun clears it.
      const turnId = this.runTurns.get(runId) ?? this.activeTurnId;
      this.finishActiveRun();
      if (view.retryVisible && turnId !== null) {
        const retryButton = el("button", "もう一度送る");
        retryButton.addEventListener("click", () => {
          void this.retry(turnId);
        });
        this.list.appendChild(retryButton);
      }
      void this.hydrateHistory();
      return;
    }
    if (view.visible === "stopped") {
      this.showNotice("停止しました");
      this.finishActiveRun();
      return;
    }
    // Active (generating) view: the reducer's notice drives the text, so
    // `run.cancel_requested` shows「停止しました」while the run stays active.
    this.showNotice(view.notice);
    this.renderComposer();
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
    const busy = this.activeRunId !== null;
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
   * cursors (event_seq known) and for catch-up that never converges (no
   * client-visible `event_seq` endpoint exists yet).
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
