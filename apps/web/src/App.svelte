<script lang="ts">
import { onMount } from "svelte";
import {
  errorCode,
  fetchJson,
  loginRemote,
  onAuthExpired,
  postJson,
  randomUuid,
} from "./lib/api.js";
import {
  ACTION_PROGRESS_TEXT,
  actionCardModel,
  actionDecisionIntentText,
  actionErrorCodeText,
  actionEvidenceButtons,
  applyRunEvent,
  INITIAL_RUN_VIEW,
  isCorruptCursor,
  isRetryableTurnKind,
  parseCancelRunStatus,
  type ProposalStatus,
  type ReceiptOutcome,
  type RunViewState,
  runResultToAnswerParts,
} from "./lib/reducer.js";

// PR-1 Svelte chat page (Q1/Q4/Q7/Q8/Q10, PR-1 scope): dark-only, Japanese,
// same APIs/SSE events + JSON fallback polling as the vanilla client.
// DOM ids match the SSR shell (`#conversation`, `#composer*`, `#drawer*`,
// `#action-approve/reject`, `data-action-*`) so the chat e2e specs run
// unchanged. No innerHTML anywhere: text only (XSS-safe plain rendering).

const LS_SESSION = "ch.sessionId";
const LS_SESSIONS = "ch.sessionIds";
const LS_PENDING_KEY = "ch.pendingKey";
const LS_CURSOR_PREFIX = "ch.cursor.";
const MAX_SEND_TEXT_LENGTH = 32768;
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "cancel_requested",
]);

interface HistoryRun {
  runId: string;
  result: unknown;
  receipt?: { outcome?: ReceiptOutcome; summary?: { summary?: string } } | null;
  executionStatus?: string | null;
  targetCitation?: unknown;
}
interface Turn {
  turnId: string;
  kind?: string;
  text?: string;
  run: HistoryRun | null;
}
interface ProposalSummary {
  proposalId: string;
  tool: string;
  input: { title?: string; start: string; end: string };
  preview: { summary: string };
  hash: string;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}
interface ExecutionView {
  proposalId: string;
  proposalStatus: ProposalStatus;
  runId: string | null;
  status: string | null;
  markerCommitted: boolean;
  cancellable: boolean;
  errorCode: string | null;
  receipt: {
    outcome: ReceiptOutcome;
    summary: { summary: string };
    createdAt: number;
  } | null;
  targetCitation?: unknown;
}
interface CardState {
  proposalId: string;
  summary: ProposalSummary;
  view: ExecutionView | null;
  deciding: boolean;
  terminal: boolean;
  runId: string | null;
  status: ProposalStatus;
  errorText: string;
  actionStopBlocked: boolean;
  deadline: number;
  hash: string;
}

function loadText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best effort.
  }
}
function lsDel(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}

// --- state ---
let sessionId: string | null = $state(null);
let sessions: string[] = $state([]);
let booted = $state(false);
let turns: Turn[] = $state([]);
let olderBefore: number | null = $state(null);
let hasMoreHistory = $state(false);
let loadingOlder = $state(false);
let input = $state("");
let notice = $state("");
let sending = $state(false);
let activeRunId: string | null = $state(null);
let activeTurnId: string | null = $state(null);
let runView: RunViewState = $state({ ...INITIAL_RUN_VIEW });
let activeRunCursor = 0;
let liveAnswer: { text: string; citations: string[] }[] = $state([]);
let liveVisible = $state(false);
let retryTurnId: string | null = $state(null);
let drawerOpen = $state(false);
let drawerBody = $state("");
let cards: CardState[] = $state([]);
let authExpired = $state(false);
let loginPassword = $state("");
let loginError = $state("");
let degradedMemory = $state(false);

let sse: EventSource | null = null;
let fallbackTimer: number | null = null;
let runChain: Promise<void> = Promise.resolve();
let renderedAnswers = new Set<string>();
let terminalHydrated = new Set<string>();
let turnKinds = new Map<string, string>();
let runTurns = new Map<string, string>();
let pendingRequest: { key: string; text: string; uiContext: unknown } | null =
  null;
let citationSeq = 0;
// Boot-seeded pre-subscription view (cancel_requested stop notice): consumed
// by the next subscribe() so the seeded notice survives the stream open,
// mirroring the legacy runViews seed preservation.
let seededRunId: string | null = null;
let watchTimers = new Map<string, number>();
let pendingExpiryTimers = new Map<string, number>();
const PENDING_EXPIRY_MAX_MS = 15 * 60 * 1000;
// C22 execution Stop state by owning run (legacy client.ts parity):
// a live, pre-marker, cancellable Action execution keeps the generic
// composer Stop, while a committed marker, a refused cancellability, or
// a terminal execution hides/disables it. Runs without an entry are
// ordinary Runs with the unchanged Stop behaviour.
interface ActionStopState {
  live: boolean;
  markerCommitted: boolean;
  cancellable: boolean;
}
let actionRunStops = $state(new Map<string, ActionStopState>());

function isProposalSummary(item: unknown): item is ProposalSummary {
  if (typeof item !== "object" || item === null) return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r["proposalId"] === "string" &&
    typeof r["hash"] === "string" &&
    typeof r["status"] === "string" &&
    typeof r["expiresAt"] === "number"
  );
}

function actionProgressText(executionStatus: string): string {
  if (
    executionStatus === "queued" ||
    executionStatus === "preflight" ||
    executionStatus === "executing"
  ) {
    return ACTION_PROGRESS_TEXT[
      executionStatus as "queued" | "preflight" | "executing"
    ];
  }
  return "";
}

function previewDisplay(summary: string): string {
  const prefix = "calendar.reschedule:";
  if (summary.startsWith(prefix)) return summary.slice(prefix.length).trim();
  return summary;
}

function formatInstant(at: number): string {
  try {
    return new Date(at).toLocaleString("ja-JP", { timeZone: "UTC" });
  } catch {
    return String(at);
  }
}

function showNotice(text: string): void {
  notice = text;
}

function composerSendDisabled(): boolean {
  // Session-gated like the vanilla composer (renderComposer): Send is
  // enabled as soon as the session exists, without waiting for the full
  // boot (history + proposals + active-run discovery) to finish, so the
  // control never stays disabled through a slow boot and early submits
  // reach send() instead of being silently dropped on a disabled button.
  if (sessionId === null || authExpired) return true;
  if (sending || activeRunId !== null) return true;
  return false;
}

function composerStopVisible(): boolean {
  if (activeRunId === null) return false;
  if (runView.visible !== "generating") return false;
  // Post-marker/terminal Action run adopted on reload: hide generic stop via
  // the ACTUAL execution map first (cards populate only after syncActions).
  if (isActionStopBlocked(activeRunId)) return false;
  for (const card of cards) {
    if (card.runId === activeRunId && card.actionStopBlocked) return false;
  }
  return true;
}

// --- sessions ---
function rememberSession(id: string): void {
  const list = sessions.includes(id) ? sessions : [...sessions, id];
  sessions = list.slice(-20);
  try {
    localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
  } catch {
    // Best effort.
  }
}

async function ensureSession(): Promise<void> {
  const stored = lsGet(LS_SESSION);
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
      sessionId = stored;
      return;
    }
    if (probeStatus === 404 || probeStatus === 410) {
      lsDel(LS_SESSION);
    } else {
      sessionId = stored;
      return;
    }
  }
  const key = randomUuid();
  const created = await postJson("/api/sessions", {}, key);
  // A transport failure yields `{ status: 0, body: null }`: never
  // dereference a null body before the status check (review PR75).
  const body = (created.body ?? {}) as { sessionId?: unknown };
  if (created.status !== 201 || typeof body.sessionId !== "string") {
    showNotice("セッションを開始できませんでした");
    return;
  }
  sessionId = body.sessionId;
  lsSet(LS_SESSION, body.sessionId);
  rememberSession(body.sessionId);
}

async function switchSession(id: string): Promise<void> {
  if (id === sessionId || sending || activeRunId !== null) return;
  closeStream();
  sessionId = id;
  lsSet(LS_SESSION, id);
  resetChatState();
  await bootSession();
}

async function newSession(): Promise<void> {
  if (sending || activeRunId !== null) return;
  const key = randomUuid();
  const created = await postJson("/api/sessions", {}, key);
  const body = (created.body ?? {}) as { sessionId?: unknown };
  if (created.status !== 201 || typeof body.sessionId !== "string") {
    showNotice("セッションを開始できませんでした");
    return;
  }
  closeStream();
  sessionId = body.sessionId;
  lsSet(LS_SESSION, body.sessionId);
  rememberSession(body.sessionId);
  resetChatState();
  await bootSession();
}

function resetChatState(): void {
  turns = [];
  olderBefore = null;
  hasMoreHistory = false;
  runView = { ...INITIAL_RUN_VIEW };
  activeRunCursor = 0;
  liveAnswer = [];
  liveVisible = false;
  retryTurnId = null;
  renderedAnswers = new Set();
  terminalHydrated = new Set();
  turnKinds = new Map();
  runTurns = new Map();
  pendingRequest = null;
  for (const timer of pendingExpiryTimers.values()) window.clearTimeout(timer);
  pendingExpiryTimers = new Map();
  cards = [];
  actionRunStops = new Map();
  degradedMemory = false;
  notice = "";
  // Invalidate and close any citation drawer from the previous session:
  // the seq bump also drops in-flight openCitation responses (review PR75).
  citationSeq += 1;
  drawerOpen = false;
  drawerBody = "";
}

// --- history ---
function trackTurnKind(item: Turn): void {
  if (
    item.turnId.length > 0 &&
    typeof item.kind === "string" &&
    item.kind.length > 0
  ) {
    turnKinds.set(item.turnId, item.kind);
  }
}

function coerceTurn(item: unknown): Turn | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r["turnId"] !== "string") return null;
  const sel = r["selectedRun"];
  let run: HistoryRun | null = null;
  if (typeof sel === "object" && sel !== null) {
    const s = sel as Record<string, unknown>;
    if (typeof s["runId"] === "string") {
      const receipt = s["receipt"];
      run = {
        runId: s["runId"],
        result: s["result"] ?? null,
        receipt:
          typeof receipt === "object" && receipt !== null
            ? (receipt as HistoryRun["receipt"])
            : null,
        executionStatus:
          typeof s["executionStatus"] === "string"
            ? s["executionStatus"]
            : null,
        targetCitation: s["targetCitation"] ?? null,
      };
    }
  }
  return {
    turnId: r["turnId"],
    kind: typeof r["kind"] === "string" ? r["kind"] : undefined,
    text: typeof r["text"] === "string" ? r["text"] : undefined,
    run,
  };
}

async function hydrateHistory(): Promise<void> {
  if (sessionId === null) return;
  // The live section stays visible until the durable projection lands, so
  // a failed refresh keeps the already-rendered terminal answer on screen
  // (same fail-open as the vanilla list rebuild). It is hidden atomically
  // with the durable assignment below, so the text never appears twice.
  const sid = sessionId;
  const pages: Turn[][] = [];
  let before: number | null = null;
  for (let round = 0; round < 20; round += 1) {
    const query =
      before === null
        ? `/api/sessions/${encodeURIComponent(sid)}/history?limit=50`
        : `/api/sessions/${encodeURIComponent(sid)}/history?limit=50&beforePosition=${before}`;
    let page: { status: number; body: unknown };
    try {
      page = await fetchJson(query);
    } catch {
      return;
    }
    if (page.status !== 200) return;
    const body = page.body as {
      items?: unknown;
      nextBefore?: unknown;
      hasMore?: unknown;
    };
    if (!Array.isArray(body.items)) return;
    const coerced: Turn[] = [];
    for (const raw of body.items) {
      const t = coerceTurn(raw);
      if (t !== null) coerced.push(t);
    }
    pages.push(coerced);
    if (body.hasMore === true && typeof body.nextBefore === "number") {
      before = body.nextBefore;
    } else {
      before = null;
      break;
    }
  }
  if (sid !== sessionId) return;
  olderBefore = before;
  hasMoreHistory = before !== null;
  const ordered: Turn[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    for (const t of pages[i] ?? []) {
      trackTurnKind(t);
      if (t.run !== null) renderedAnswers.add(t.run.runId);
      ordered.push(t);
    }
  }
  // Atomic handover: the durable projection owns the terminal text from
  // this paint on, so the live section hides in the same batch and the
  // answer is never rendered twice.
  liveVisible = false;
  turns = ordered;
}

async function loadOlderHistory(): Promise<void> {
  if (sessionId === null || olderBefore === null || loadingOlder) return;
  loadingOlder = true;
  try {
    const sid = sessionId;
    const pages: Turn[][] = [];
    let before: number | null = olderBefore;
    for (let round = 0; round < 20 && before !== null; round += 1) {
      let page: { status: number; body: unknown };
      try {
        page = await fetchJson(
          `/api/sessions/${encodeURIComponent(sid)}/history?limit=50&beforePosition=${before}`,
        );
      } catch {
        return;
      }
      if (
        page.status !== 200 ||
        !Array.isArray((page.body as { items?: unknown }).items)
      )
        return;
      const body = page.body as {
        items?: unknown;
        nextBefore?: unknown;
        hasMore?: unknown;
      };
      const coerced: Turn[] = [];
      for (const raw of body.items as unknown[]) {
        const t = coerceTurn(raw);
        if (t !== null) coerced.push(t);
      }
      pages.push(coerced);
      before =
        body.hasMore === true && typeof body.nextBefore === "number"
          ? body.nextBefore
          : null;
    }
    if (sid !== sessionId) return;
    const prepended: Turn[] = [];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      for (const t of pages[i] ?? []) {
        trackTurnKind(t);
        if (t.run !== null) renderedAnswers.add(t.run.runId);
        prepended.push(t);
      }
    }
    turns = [...prepended, ...turns];
    olderBefore = before;
    hasMoreHistory = before !== null;
  } finally {
    loadingOlder = false;
  }
}

// --- send / retry / stop ---
async function fetchUiContext(): Promise<unknown> {
  if (sessionId === null) return {};
  try {
    const context = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/reference-context`,
    );
    const body = context.body as { version?: unknown; items?: unknown };
    if (
      context.status === 200 &&
      typeof body.version === "number" &&
      Array.isArray(body.items)
    ) {
      return { referenceContext: { version: body.version, items: body.items } };
    }
  } catch {
    // Fall through to the default empty context.
  }
  return {};
}

async function send(): Promise<void> {
  if (sessionId === null) {
    showNotice("セッションを開始できませんでした");
    return;
  }
  if (activeRunId !== null || sending) return;
  if (pendingRequest === null) {
    const text = input;
    if (text.trim().length === 0) return;
    if (text.length > MAX_SEND_TEXT_LENGTH) {
      showNotice("入力を確認してください");
      return;
    }
    const request = { key: randomUuid(), text, uiContext: {} as unknown };
    pendingRequest = request;
    // Optimistic user bubble (§16.2).
    turns = [...turns, { turnId: "", kind: "user_text", text, run: null }];
    input = "";
    // `sending` stays true until the message POST settles (review PR75):
    // the composer, session switch, and new-session controls must stay
    // locked while the request is in flight. fetchUiContext() never throws.
    sending = true;
    request.uiContext = await fetchUiContext();
  }
  const request = pendingRequest;
  if (request === null) return;
  try {
    lsSet(LS_PENDING_KEY, request.key);
  } catch {
    // Best effort.
  }
  let posted: { status: number; body: unknown };
  const sendSid = sessionId;
  try {
    posted = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      { text: request.text, uiContext: request.uiContext },
      request.key,
    );
  } catch {
    sending = false;
    showNotice("送信できませんでした。もう一度お試しください");
    return;
  }
  // The POST has settled: release the composer before applying the result,
  // and drop the response entirely if the user moved to another session
  // while it was in flight (its run must never subscribe here).
  sending = false;
  if (sessionId !== sendSid) return;
  const body = (posted.body ?? {}) as {
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
    lsDel(LS_PENDING_KEY);
    pendingRequest = null;
    activeTurnId = body.turnId;
    runTurns.set(runId, body.turnId);
    turnKinds.set(body.turnId, "user_text");
    subscribe(runId);
    return;
  }
  const code = errorCode(posted.body);
  if (posted.status === 409 && code === "session_busy") {
    showNotice("生成中のため送信できません");
    await hydrateHistory();
    return;
  }
  if (
    posted.status >= 400 &&
    posted.status < 500 &&
    posted.status !== 408 &&
    posted.status !== 425 &&
    posted.status !== 429
  ) {
    const frozenText = request.text;
    lsDel(LS_PENDING_KEY);
    pendingRequest = null;
    input = frozenText;
    showNotice("入力を確認してください");
    return;
  }
  showNotice("送信できませんでした。もう一度お試しください");
}

async function retry(turnId: string): Promise<void> {
  if (sessionId === null || activeRunId !== null) return;
  if (!isRetryableTurnKind(turnKinds.get(turnId))) {
    showNotice("再試行できませんでした");
    return;
  }
  const key = randomUuid();
  const posted = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retries`,
    {},
    key,
  );
  const body = (posted.body ?? {}) as {
    turnId?: unknown;
    run?: { id?: unknown };
  };
  const run = body.run;
  const runId =
    typeof run === "object" && run !== null
      ? (run as { id?: unknown }).id
      : null;
  if (posted.status === 202 && typeof runId === "string") {
    activeTurnId = turnId;
    runTurns.set(runId, turnId);
    turnKinds.set(turnId, "user_text");
    retryTurnId = null;
    subscribe(runId);
    return;
  }
  showNotice("再試行できませんでした");
}

function isActionStopBlocked(runId: string): boolean {
  const state = actionRunStops.get(runId);
  if (state === undefined) {
    return false;
  }
  return !state.live || state.markerCommitted || !state.cancellable;
}

async function stop(): Promise<void> {
  if (sessionId === null || activeRunId === null) return;
  if (isActionStopBlocked(activeRunId)) {
    await refreshActionRunStops();
    await syncActions();
    return;
  }
  const posted = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(activeRunId)}/cancel`,
    {},
    null,
  );
  if (posted.status < 200 || posted.status >= 300) {
    showNotice("停止できませんでした");
    return;
  }
  if (actionRunStops.has(activeRunId)) {
    if (parseCancelRunStatus(posted.body) === "cancelled") {
      showNotice("停止しました");
    }
    await refreshActionRunStops();
    await syncActions();
    return;
  }
  // The terminal `run.cancelled` / `run.cancel_requested` events render
  // the「停止しました」notice through the stream path.
}

// --- run event pipeline (SSE + JSON fallback, §16.4/§16.7) ---
function readStoredCursor(runId: string): number | null {
  try {
    const raw = localStorage.getItem(LS_CURSOR_PREFIX + runId);
    if (raw === null || raw.length === 0) return null;
    if (!/^\d+$/.test(raw.trim())) return null;
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function storeCursor(runId: string, cursor: number): void {
  try {
    localStorage.setItem(LS_CURSOR_PREFIX + runId, String(cursor));
  } catch {
    // Best effort.
  }
}

// Drops a poisoned cursor so the resubscription replays from the durable
// history (dedup keeps it exactly-once); without this an ahead-poisoned key
// survives resync and the re-opened stream replays nothing.
function clearStoredCursor(runId: string): void {
  try {
    localStorage.removeItem(LS_CURSOR_PREFIX + runId);
  } catch {
    // Best effort.
  }
}

function closeStream(): void {
  if (sse !== null) {
    try {
      sse.close();
    } catch {
      // Best effort.
    }
    sse = null;
  }
  if (fallbackTimer !== null) {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function finishActiveRun(): void {
  closeStream();
  activeRunId = null;
  activeTurnId = null;
}

function subscribe(runId: string): void {
  if (sessionId === null) return;
  closeStream();
  activeRunId = runId;
  retryTurnId = null;
  if (seededRunId === runId) {
    // Boot-seeded pre-subscription view (e.g. the cancel_requested stop
    // notice): preserved across the stream open; the real events stay
    // authoritative for the terminal.
    seededRunId = null;
  } else {
    liveAnswer = [];
    liveVisible = false;
    runView = { ...INITIAL_RUN_VIEW };
    activeRunCursor = 0;
  }
  showNotice(runView.notice);
  const sid = sessionId;
  const stored = readStoredCursor(runId);
  void validateStoredCursor(runId, stored ?? 0);
  const query = stored !== null && stored > 0 ? `?after=${stored}` : "";
  const url = `/api/sessions/${encodeURIComponent(sid)}/runs/${encodeURIComponent(runId)}/events/stream${query}`;
  let opened = false;
  try {
    sse = new EventSource(url);
  } catch {
    sse = null;
  }
  if (sse === null) {
    void pollFallback(runId);
    return;
  }
  const source = sse;
  fallbackTimer = window.setTimeout(() => {
    if (!opened) {
      closeStream();
      void pollFallback(runId);
    }
  }, 5000);
  source.addEventListener("run-event", (message) => {
    opened = true;
    const raw = (message as MessageEvent).data;
    let event: { seq?: unknown; type?: unknown; payload?: unknown } | null =
      null;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : "") as {
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
    applySerialized(runId, {
      seq: event.seq,
      type: event.type,
      payload: event.payload,
    });
  });
  source.onerror = () => {
    if (activeRunId !== runId) return;
    if (
      runView.visible === "answered" ||
      runView.visible === "failed" ||
      runView.visible === "stopped"
    ) {
      finishActiveRun();
    }
  };
}

async function validateStoredCursor(
  runId: string,
  cursor: number,
): Promise<void> {
  if (sessionId === null || cursor <= 0 || activeRunId !== runId) return;
  let fetched: { status: number; body: unknown };
  try {
    fetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/status`,
    );
  } catch {
    return;
  }
  if (activeRunId !== runId || fetched.status !== 200) return;
  const run = (fetched.body as { run?: unknown }).run;
  if (typeof run !== "object" || run === null) return;
  const r = run as { id?: unknown; eventSeq?: unknown };
  if (r.id !== runId || typeof r.eventSeq !== "number") return;
  if (isCorruptCursor(cursor, r.eventSeq)) {
    await resyncFromHistory(runId);
    if (sessionId !== null) subscribe(runId);
  }
}

async function resyncFromHistory(runId: string): Promise<void> {
  // Normalize a poisoned stored cursor BEFORE the re-subscribe reads it:
  // replay-from-zero plus the reducer dedup converges to exactly one answer
  // and the live ticks rewrite the key with the real cursor.
  clearStoredCursor(runId);
  await hydrateHistory();
  if (activeRunId === runId) {
    activeRunCursor = 0;
    runView = { ...INITIAL_RUN_VIEW };
  }
}

function applySerialized(
  runId: string,
  event: { seq: number; type: string; payload: unknown },
): void {
  const absorbed = runChain.catch(() => {});
  const link = absorbed.then(async () => {
    try {
      if (activeRunId !== runId) return;
      const applied = applyRunEvent(
        { ...runView, cursor: activeRunCursor },
        event,
      );
      if (applied.outcome.kind === "ignored-duplicate") return;
      if (applied.outcome.kind === "ignored-unknown") {
        activeRunCursor = applied.state.cursor;
        storeCursor(runId, applied.state.cursor);
        return;
      }
      if (applied.outcome.kind === "needs-catchup") {
        const ok = await catchUp(runId, activeRunCursor);
        if (!ok) return;
        const second = applyRunEvent(
          { ...runView, cursor: activeRunCursor },
          event,
        );
        if (second.outcome.kind === "needs-catchup") {
          await resyncFromHistory(runId);
          return;
        }
        if (second.outcome.kind === "ignored-duplicate") {
          renderRunView(runId);
          return;
        }
        if (second.outcome.kind === "ignored-unknown") {
          activeRunCursor = second.state.cursor;
          storeCursor(runId, second.state.cursor);
          return;
        }
        runView = second.state;
        activeRunCursor = second.state.cursor;
        storeCursor(runId, second.state.cursor);
        renderRunView(runId);
        return;
      }
      runView = applied.state;
      activeRunCursor = applied.state.cursor;
      storeCursor(runId, applied.state.cursor);
      renderRunView(runId);
    } catch {
      // One bad tick never wedges later events.
    }
  });
  runChain = link.catch(() => {});
}

async function catchUp(
  runId: string,
  after: number,
  onPage?: () => void,
): Promise<boolean> {
  if (sessionId === null) return true;
  let cursor = after;
  for (let page = 0; page < 20; page += 1) {
    let fetched: { status: number; body: unknown };
    try {
      fetched = await fetchJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${cursor}&limit=50`,
      );
    } catch {
      return false;
    }
    if (fetched.status < 200 || fetched.status >= 300) return false;
    const body = fetched.body as {
      events?: Array<{ seq?: unknown; type?: unknown; payload?: unknown }>;
      nextAfter?: unknown;
    };
    if (!Array.isArray(body.events)) return false;
    // A 2xx page with a well-formed body resets the caller's consecutive
    // failure streak even when a later page in the same drain fails: the
    // streak counts consecutive failed page requests, not poll iterations.
    onPage?.();
    for (const item of body.events) {
      if (typeof item.seq !== "number" || typeof item.type !== "string")
        continue;
      if (activeRunId !== runId) return true;
      const applied = applyRunEvent(
        { ...runView, cursor: activeRunCursor },
        { seq: item.seq, type: item.type, payload: item.payload },
      );
      if (applied.outcome.kind === "needs-catchup") return true;
      if (applied.outcome.kind === "ignored-duplicate") continue;
      runView = applied.state;
      activeRunCursor = applied.state.cursor;
      storeCursor(runId, applied.state.cursor);
    }
    cursor = typeof body.nextAfter === "number" ? body.nextAfter : cursor + 1;
    if (activeRunId !== runId) return true;
    // Stop at the first empty page like the vanilla client: the drain must
    // not outrun the live SSE stream. A terminal event created mid-drain
    // would otherwise be consumed here via JSON, render, and close the
    // stream before the server's next poll delivers the native terminal
    // frame (C06 native-resubscription race).
    if (body.events.length === 0) return true;
  }
  return true;
}

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ERROR_STREAK = 5;

async function pollFallback(runId: string): Promise<void> {
  let errorStreak = 0;
  for (;;) {
    if (activeRunId !== runId) return;
    let ok = false;
    try {
      // Successful pages inside the drain reset the streak per request, so
      // an interleaved [fail×4, ok, ok, fail×4, ok] pattern converges instead
      // of tripping the 5-consecutive stop on cumulative failures.
      ok = await catchUp(runId, activeRunCursor, () => {
        errorStreak = 0;
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      errorStreak += 1;
      if (errorStreak >= POLL_MAX_ERROR_STREAK) {
        showNotice("状態の取得に失敗しました。再読み込みしてください");
        return;
      }
    } else {
      errorStreak = 0;
    }
    if (activeRunId !== runId) return;
    renderRunView(runId);
    if (runView.visible !== "generating") {
      finishActiveRun();
      return;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
}

function renderRunView(runId: string): void {
  if (runView.visible === "answered") {
    if (renderedAnswers.has(runId)) {
      finishActiveRun();
      if (!terminalHydrated.has(runId)) {
        terminalHydrated.add(runId);
        void hydrateHistory().then(() => {
          void syncActions();
        });
      }
      return;
    }
    renderedAnswers.add(runId);
    liveAnswer = runView.answer.map((p) => ({
      text: p.text,
      citations: [...p.citations],
    }));
    liveVisible = true;
    finishActiveRun();
    if (!terminalHydrated.has(runId)) {
      terminalHydrated.add(runId);
      void hydrateHistory().then(() => {
        void checkDegradedMemory(runId);
        void syncActions();
      });
    }
    return;
  }
  if (runView.visible === "failed") {
    showNotice("生成に失敗しました");
    const turnId = runTurns.get(runId) ?? activeTurnId;
    const retryVisible = runView.retryVisible;
    finishActiveRun();
    if (!terminalHydrated.has(runId)) {
      terminalHydrated.add(runId);
      void hydrateHistory().then(() => {
        if (
          retryVisible &&
          turnId !== null &&
          turnId !== undefined &&
          isRetryableTurnKind(turnKinds.get(turnId))
        ) {
          retryTurnId = turnId;
        }
        void syncActions();
      });
    }
    return;
  }
  if (runView.visible === "stopped") {
    showNotice("停止しました");
    finishActiveRun();
    if (!terminalHydrated.has(runId)) {
      terminalHydrated.add(runId);
      void hydrateHistory().then(() => {
        void syncActions();
      });
    }
    return;
  }
  showNotice(runView.notice);
}

async function checkDegradedMemory(runId: string): Promise<void> {
  if (sessionId === null) return;
  try {
    const fetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/status`,
    );
    if (fetched.status !== 200) return;
    const mem = (fetched.body as { run?: { memoryStatus?: unknown } }).run
      ?.memoryStatus;
    if (typeof mem === "string" && mem !== "used" && mem !== "empty") {
      degradedMemory = true;
      showNotice("記憶なしで続行しています");
    }
  } catch {
    // Best effort.
  }
}

// --- citations (rN stored + mN run-bound, §16.5) ---
async function updateReferenceContextCas(
  referenceId: string,
  sid: string,
  seq: number,
): Promise<void> {
  const currentDrawer = (): boolean => sessionId === sid && seq === citationSeq;
  const base = `/api/sessions/${encodeURIComponent(sid)}/reference-context`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!currentDrawer()) return;
    let current: { status: number; body: unknown };
    try {
      current = await fetchJson(base);
    } catch {
      return;
    }
    if (!currentDrawer() || current.status !== 200) return;
    const stored = current.body as { version?: unknown; items?: unknown };
    if (
      typeof stored.version !== "number" ||
      !Number.isSafeInteger(stored.version) ||
      stored.version < 1 ||
      !Array.isArray(stored.items)
    ) {
      return;
    }
    const items = (stored.items as unknown[]).filter(
      (item): item is string =>
        typeof item === "string" && item.length > 0 && item !== referenceId,
    );
    if (items.length !== (stored.items as unknown[]).length) return;
    items.push(referenceId);
    if (!currentDrawer()) return;
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
    if (!currentDrawer()) return;
    if (put.status >= 200 && put.status < 300) return;
    if (put.status !== 409) return;
    showNotice("参照の更新で競合しました。最新の状態を取得しています");
  }
}

async function openCitation(citation: string, runId?: string): Promise<void> {
  citationSeq += 1;
  const seq = citationSeq;
  const sid = sessionId;
  drawerBody = "";
  drawerOpen = false;
  if (/^m[1-9][0-9]*$/.test(citation)) {
    await openMemoryCitation(citation, runId, seq, sid);
    return;
  }
  if (sid === null) return;
  let listed: { status: number; body: unknown };
  try {
    listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/references`,
    );
  } catch {
    return;
  }
  if (sessionId !== sid || seq !== citationSeq) return;
  const items = (listed.body as { items?: unknown }).items;
  let referenceId: string | null = null;
  if (Array.isArray(items)) {
    for (const item of items as Array<{ id?: unknown; ordinal?: unknown }>) {
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
  if (referenceId === null) return;
  await updateReferenceContextCas(referenceId, sid, seq);
  if (sessionId !== sid || seq !== citationSeq) return;
  let detail: { status: number; body: unknown };
  try {
    detail = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/references/${encodeURIComponent(referenceId)}`,
    );
  } catch {
    return;
  }
  if (sessionId !== sid || seq !== citationSeq) return;
  const snapshot = (detail.body as { body?: unknown }).body;
  const snapshotText =
    typeof snapshot === "object" && snapshot !== null
      ? (snapshot as { text?: unknown }).text
      : snapshot;
  drawerBody = loadText(snapshotText);
  drawerOpen = true;
}

async function openMemoryCitation(
  handle: string,
  runId: string | undefined,
  seq: number,
  sid: string | null,
): Promise<void> {
  if (sid === null) return;
  if (runId === undefined || runId.length === 0) {
    if (sessionId !== sid || seq !== citationSeq) return;
    showNotice("先に「記憶を検索」で対象を探してください");
    return;
  }
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/memory/recall/${encodeURIComponent(runId)}/items/${encodeURIComponent(handle)}`,
    );
  } catch {
    if (sessionId !== sid || seq !== citationSeq) return;
    showNotice("記憶の引用取得に失敗しました");
    return;
  }
  if (sessionId !== sid || seq !== citationSeq) return;
  if (res.status === 404) {
    const code = errorCode(res.body);
    if (code === "memory_unavailable") {
      showNotice("記憶は無効です");
      return;
    }
    showNotice("引用が見つかりません。再検索してください");
    return;
  }
  if (res.status !== 200) {
    showNotice("記憶の引用取得に失敗しました");
    return;
  }
  const body = res.body as { snippet?: unknown };
  const snippet = typeof body.snippet === "string" ? body.snippet : "";
  if (snippet.length === 0) {
    showNotice("引用が見つかりません。再検索してください");
    return;
  }
  // Immutable cited snapshot for THIS run (never rebound): the drawer shows
  // exactly what the model saw as `mN`, with the run-bound kind framing.
  drawerBody = `引用 ${handle}\n${snippet}`;
  drawerOpen = true;
}

function closeDrawer(): void {
  citationSeq += 1;
  drawerBody = "";
  drawerOpen = false;
}

// --- approval cards (C22 verbatim) ---
function approveKeyStorageKey(proposalId: string): string {
  return `ch.pendingApprovalKey.${proposalId}`;
}

function approveKey(proposalId: string): string {
  const existing = lsGet(approveKeyStorageKey(proposalId));
  if (existing !== null && existing.length > 0) return existing;
  const key = randomUuid();
  lsSet(approveKeyStorageKey(proposalId), key);
  return key;
}

function clearApproveKey(proposalId: string): void {
  lsDel(approveKeyStorageKey(proposalId));
}

function cardModel(card: CardState): {
  decisionVisible: boolean;
  expired: boolean;
  progressText: string;
  stopVisible: boolean;
  outcomeText: string;
} {
  const summary = card.summary;
  const view = card.view;
  const model = actionCardModel({
    status: card.status,
    expiresAt: summary.expiresAt,
    executionStatus: view?.status ?? null,
    markerCommitted: view?.markerCommitted ?? false,
    cancellable: view?.cancellable ?? false,
    receiptOutcome: view?.receipt?.outcome ?? null,
    receiptSummary:
      typeof view?.receipt?.summary?.summary === "string"
        ? view.receipt.summary.summary
        : null,
    preview: previewDisplay(summary.preview.summary),
    now: Date.now(),
  });
  return model;
}

function trackActionExecutionView(view: ExecutionView): void {
  if (view.runId === null) return;
  const live =
    view.status === "queued" ||
    view.status === "preflight" ||
    view.status === "executing";
  actionRunStops.set(view.runId, {
    live,
    markerCommitted: view.markerCommitted === true,
    cancellable: view.cancellable === true,
  });
  const blocked = live && view.markerCommitted;
  const terminal =
    view.receipt !== null ||
    (view.status !== null &&
      view.status !== "queued" &&
      view.status !== "preflight" &&
      view.status !== "executing");
  for (const card of cards) {
    if (
      card.runId === view.runId &&
      typeof view.runId === "string" &&
      view.runId.length > 0
    ) {
      card.actionStopBlocked = blocked || terminal;
    }
  }
  cards = [...cards];
}

/**
 * Read-only refresh of every decided proposal's ACTUAL execution Stop
 * state through the existing proposals/execution APIs (no DOM, no card
 * side effects). Boot awaits this before the first hydration paint so a
 * reloaded post-marker Action cannot offer Stop even briefly (legacy
 * client.ts refreshActionRunStops parity).
 */
async function refreshActionRunStops(): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  let listed: { status: number; body: unknown };
  try {
    listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals`,
    );
  } catch {
    return;
  }
  if (listed.status !== 200 || sessionId !== sid) return;
  const proposals = (listed.body as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposals)) return;
  for (const item of proposals) {
    if (!isProposalSummary(item) || item.status === "pending") continue;
    let fetched: { status: number; body: unknown };
    try {
      fetched = await fetchJson(
        `/api/sessions/${encodeURIComponent(sid)}/proposals/${encodeURIComponent(item.proposalId)}/execution`,
      );
    } catch {
      continue;
    }
    if (fetched.status !== 200 || sessionId !== sid) continue;
    const view = fetched.body as ExecutionView;
    if (typeof view.proposalId !== "string") continue;
    trackActionExecutionView(view);
  }
}

function clearPendingExpiry(proposalId: string): void {
  const timer = pendingExpiryTimers.get(proposalId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pendingExpiryTimers.delete(proposalId);
  }
}

function removeActionCard(proposalId: string): void {
  clearPendingExpiry(proposalId);
  cards = cards.filter((c) => c.proposalId !== proposalId);
}

/**
 * (Re)arm the card's single one-shot pending-expiry timer (legacy
 * client.ts schedulePendingExpiry parity). At most one timer per card,
 * capped at ~15min; the callback re-checks identity and never retires a
 * decided/executing/terminal/awaiting card. Clock-skew re-arm when the
 * capped shot fires before the real deadline.
 */
function schedulePendingExpiry(proposalId: string): void {
  clearPendingExpiry(proposalId);
  const card = cards.find((c) => c.proposalId === proposalId);
  if (
    card === undefined ||
    card.status !== "pending" ||
    card.terminal ||
    card.runId !== null
  ) {
    return;
  }
  const hash = card.hash;
  const deadline = card.deadline;
  const status = card.status;
  const delay = Math.min(
    Math.max(deadline - Date.now(), 0),
    PENDING_EXPIRY_MAX_MS,
  );
  const timer = window.setTimeout(() => {
    const current = cards.find((c) => c.proposalId === proposalId);
    if (current === undefined || current !== card) return;
    if (
      current.hash !== hash ||
      current.deadline !== deadline ||
      current.status !== status
    ) {
      return;
    }
    if (
      current.terminal ||
      current.runId !== null ||
      current.deciding ||
      current.status !== "pending"
    ) {
      return;
    }
    if (Date.now() < current.deadline) {
      schedulePendingExpiry(proposalId);
      return;
    }
    removeActionCard(proposalId);
  }, delay);
  pendingExpiryTimers.set(proposalId, timer);
}

/**
 * Local tab-resume reconciliation (no network): retire every still-pending
 * local card whose server deadline has passed. Execution/awaited cards are
 * untouched; the server stays authoritative on next sync.
 */
function reconcilePendingExpiry(): void {
  const now = Date.now();
  for (const card of [...cards]) {
    if (
      card.terminal ||
      card.runId !== null ||
      card.deciding ||
      card.status !== "pending"
    ) {
      continue;
    }
    if (now >= card.deadline) {
      removeActionCard(card.proposalId);
    }
  }
}

async function syncActions(): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  let listed: { status: number; body: unknown };
  try {
    listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals`,
    );
  } catch {
    return;
  }
  if (listed.status !== 200 || sessionId !== sid) return;
  const items = (listed.body as { proposals?: unknown }).proposals;
  if (!Array.isArray(items)) return;
  const summaries = (items as unknown[]).filter(isProposalSummary);
  const now = Date.now();
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (summary.status === "pending") {
      if (summary.expiresAt <= now) {
        const stale = cards.find((c) => c.proposalId === summary.proposalId);
        if (
          stale !== undefined &&
          !stale.terminal &&
          stale.runId === null &&
          !stale.deciding &&
          stale.status === "pending"
        ) {
          removeActionCard(summary.proposalId);
        }
        continue;
      }
      seen.add(summary.proposalId);
      const existing = cards.find((c) => c.proposalId === summary.proposalId);
      if (existing !== undefined) {
        if (
          existing.terminal ||
          existing.runId !== null ||
          existing.deciding ||
          existing.status !== "pending"
        ) {
          continue;
        }
        existing.summary = summary;
        existing.deadline = summary.expiresAt;
        existing.hash = summary.hash;
        cards = [...cards];
        schedulePendingExpiry(existing.proposalId);
      } else {
        cards = [
          ...cards,
          {
            proposalId: summary.proposalId,
            summary,
            view: null,
            deciding: false,
            terminal: false,
            runId: null,
            status: "pending",
            errorText: "",
            actionStopBlocked: false,
            deadline: summary.expiresAt,
            hash: summary.hash,
          },
        ];
        schedulePendingExpiry(summary.proposalId);
      }
    }
  }
  // Retire cards whose proposals vanished or decided without execution.
  let needHistory = false;
  for (const summary of summaries) {
    if (summary.status === "pending") continue;
    const card = cards.find((c) => c.proposalId === summary.proposalId);
    if (summary.status === "rejected" || summary.status === "expired") {
      if (card !== undefined) {
        clearApproveKey(summary.proposalId);
        removeActionCard(summary.proposalId);
        needHistory = true;
      }
      continue;
    }
    if (
      card !== undefined &&
      !card.terminal &&
      card.runId === null &&
      !card.deciding
    ) {
      card.status = summary.status;
      cards = [...cards];
    }
  }
  for (const summary of summaries) {
    if (summary.status === "pending") continue;
    if (await syncExecution(summary)) needHistory = true;
  }
  // Start execution watches for approved cards with runs.
  for (const card of cards) {
    if (
      card.runId !== null &&
      !card.terminal &&
      !watchTimers.has(card.proposalId)
    ) {
      void watchAction(card.proposalId, card.summary);
    }
  }
  if (needHistory && sessionId === sid) {
    await hydrateHistory();
  }
}

async function syncExecution(summary: ProposalSummary): Promise<boolean> {
  if (sessionId === null) return false;
  const sid = sessionId;
  // Authoritative non-pending ownership BEFORE the execution GET: a
  // server-decided summary owns the local card even when the execution
  // read below fails (lost approve/reject delivery). A rejected/expired
  // summary retires on the real list state; an approved one becomes
  // execution-owned with disabled decisions while preserving any known
  // run. The watch starts only AFTER the current execution GET below, so
  // this call never runs two concurrent execution reads for one proposal.
  const owned = cards.find((c) => c.proposalId === summary.proposalId);
  let claimedApproved = false;
  if (
    owned !== undefined &&
    !owned.terminal &&
    summary.status !== "pending" &&
    owned.status === "pending" &&
    owned.runId === null
  ) {
    owned.status = summary.status;
    owned.summary = summary;
    owned.deciding = false;
    clearPendingExpiry(owned.proposalId);
    if (summary.status === "rejected" || summary.status === "expired") {
      clearApproveKey(summary.proposalId);
      removeActionCard(summary.proposalId);
      return true;
    }
    cards = [...cards];
    claimedApproved = true;
  }
  let fetched: { status: number; body: unknown };
  try {
    fetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals/${encodeURIComponent(summary.proposalId)}/execution`,
    );
  } catch {
    if (claimedApproved) void watchAction(summary.proposalId, summary);
    return false;
  }
  if (fetched.status !== 200 || sessionId !== sid) {
    if (claimedApproved) void watchAction(summary.proposalId, summary);
    return false;
  }
  const view = fetched.body as ExecutionView;
  if (typeof view.proposalId !== "string") return false;
  const preCard = cards.find((c) => c.proposalId === view.proposalId);
  if (preCard?.terminal) return false;
  trackActionExecutionView(view);
  // The execution read is the AUTHORITATIVE proposal state: a watch started
  // from the pre-approval (still `pending`) summary must never keep
  // rendering a decided/executed proposal as an actionable pending card.
  const actual: ProposalSummary =
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
  const card = cards.find((c) => c.proposalId === view.proposalId);
  if (actual.status === "rejected" || actual.status === "expired") {
    clearApproveKey(view.proposalId);
    if (card !== undefined) {
      card.deciding = false;
      removeActionCard(view.proposalId);
      return true;
    }
    return false;
  }
  const errorText =
    typeof view.errorCode === "string"
      ? actionErrorCodeText(
          view.errorCode as
            | "action_preflight_failed"
            | "action_cancelled_before_write"
            | "action_write_failed"
            | "action_recovery_abandoned_before_write"
            | "database_state_invalid",
        )
      : "";
  if (terminal && view.status !== null) {
    // Terminal: the REAL receipt (or the real fixed failure text) is
    // rendered ON the card the user was already looking at — the approval
    // card is never retired before the outcome is shown. No card (e.g.
    // after a reload): nothing to render, but the single batched history
    // refresh still lands the receipt/citation.
    clearApproveKey(view.proposalId);
    clearPendingExpiry(view.proposalId);
    if (card !== undefined) {
      if (typeof view.runId === "string" && view.runId.length > 0) {
        card.runId = view.runId;
        runTurns.set(view.runId, activeTurnId ?? "");
      }
      card.terminal = true;
      card.deciding = false;
      card.status = actual.status;
      card.summary = actual;
      card.view = view;
      card.errorText = errorText;
      cards = [...cards];
    }
    return true;
  }
  if (card === undefined) return false;
  if (typeof view.runId === "string" && view.runId.length > 0) {
    card.runId = view.runId;
    runTurns.set(view.runId, activeTurnId ?? "");
  }
  card.deciding = false;
  card.status = actual.status;
  card.summary = actual;
  card.view = view;
  card.errorText = errorText;
  if (view.runId !== null || view.status !== null) {
    clearPendingExpiry(card.proposalId);
  }
  cards = [...cards];
  if (
    view.status !== null &&
    (view.status === "queued" ||
      view.status === "preflight" ||
      view.status === "executing")
  ) {
    void watchAction(view.proposalId, summary);
  }
  return false;
}

async function watchAction(
  proposalId: string,
  summary: ProposalSummary,
): Promise<void> {
  if (sessionId === null || watchTimers.has(proposalId)) return;
  const sid = sessionId;
  let ticks = 0;
  let inFlight = false;
  const maxTicks = 16 * 60;
  const timer = window.setInterval(async () => {
    ticks += 1;
    if (ticks > maxTicks || sessionId !== sid) {
      window.clearInterval(timer);
      watchTimers.delete(proposalId);
      return;
    }
    const card = cards.find((c) => c.proposalId === proposalId);
    if (card === undefined || card.terminal) {
      window.clearInterval(timer);
      watchTimers.delete(proposalId);
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const needHistory = await syncExecution(summary);
      if (needHistory && sessionId === sid) {
        await hydrateHistory();
      }
    } finally {
      inFlight = false;
    }
    if (cards.find((c) => c.proposalId === proposalId) === undefined) {
      window.clearInterval(timer);
      watchTimers.delete(proposalId);
      return;
    }
  }, 1000);
  watchTimers.set(proposalId, timer);
}

async function reconcileLostApprove(card: CardState): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  if (cards.find((c) => c.proposalId === card.proposalId) !== card) return;
  try {
    const listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals`,
    );
    const items = (listed.body as { proposals?: unknown }).proposals;
    if (listed.status === 200 && Array.isArray(items) && sessionId === sid) {
      const current = (items as unknown[]).find(
        (item): item is ProposalSummary =>
          isProposalSummary(item) && item.proposalId === card.proposalId,
      );
      if (current !== undefined && current.status === "approved") {
        clearPendingExpiry(card.proposalId);
        card.status = "approved";
        card.summary = current;
        card.deciding = false;
        cards = [...cards];
        void watchAction(card.proposalId, current);
        return;
      }
      if (cards.find((c) => c.proposalId === card.proposalId) !== card) return;
      if (current !== undefined && current.status === "pending") {
        card.deadline = current.expiresAt;
        card.hash = current.hash;
        card.status = current.status;
        card.summary = current;
        card.deciding = false;
        cards = [...cards];
        schedulePendingExpiry(card.proposalId);
      }
    }
  } catch {
    // Best effort.
  }
  if (cards.find((c) => c.proposalId === card.proposalId) !== card) return;
  card.deciding = false;
  cards = [...cards];
  void syncActions();
}

async function approve(card: CardState): Promise<void> {
  if (sessionId === null || card.deciding || card.terminal) return;
  // Local deadline precheck (server re-read stays authoritative).
  if (card.status !== "pending" || Date.now() >= card.deadline) {
    showNotice("この変更は承認できません。内容を確認してください");
    removeActionCard(card.proposalId);
    void syncActions();
    return;
  }
  const sid = sessionId;
  let current: ProposalSummary | null = null;
  try {
    const listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals`,
    );
    const items = (listed.body as { proposals?: unknown }).proposals;
    if (listed.status === 200 && Array.isArray(items)) {
      current =
        (items as unknown[]).find(
          (item): item is ProposalSummary =>
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
    showNotice("この変更は承認できません。内容を確認してください");
    removeActionCard(card.proposalId);
    void syncActions();
    return;
  }
  const key = approveKey(card.proposalId);
  card.deciding = true;
  cards = [...cards];
  let posted: { status: number; body: unknown };
  try {
    posted = await postJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals/${encodeURIComponent(card.proposalId)}/approve`,
      { proposalHash: card.summary.hash },
      key,
    );
  } catch {
    showNotice("承認できませんでした。もう一度お試しください");
    await reconcileLostApprove(card);
    return;
  }
  if (posted.status === 202) {
    clearPendingExpiry(card.proposalId);
    card.deciding = false;
    clearApproveKey(card.proposalId);
    const body = posted.body as { runId?: unknown };
    if (typeof body.runId === "string") card.runId = body.runId;
    // The 202 is authoritative: claim the approved state so the decision
    // controls disappear while the execution runs (review PR75).
    card.status = "approved";
    card.summary = current;
    showNotice("承認しました");
    cards = [...cards];
    void watchAction(card.proposalId, current);
    return;
  }
  if (posted.status === 409) {
    card.deciding = false;
    clearApproveKey(card.proposalId);
    showNotice("この変更は承認できません。内容を確認してください");
    await hydrateHistory();
    void syncActions();
    return;
  }
  card.deciding = false;
  cards = [...cards];
  showNotice("承認できませんでした。もう一度お試しください");
  void syncActions();
}

async function reject(card: CardState): Promise<void> {
  if (sessionId === null || card.deciding || card.terminal) return;
  // Local deadline precheck (server stays authoritative): a locally
  // expired pending card is never decided from a stale click.
  if (card.status !== "pending" || Date.now() >= card.deadline) {
    showNotice("却下できませんでした。内容を確認してください");
    removeActionCard(card.proposalId);
    void syncActions();
    return;
  }
  const sid = sessionId;
  card.deciding = true;
  cards = [...cards];
  let posted: { status: number; body: unknown };
  try {
    posted = await postJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals/${encodeURIComponent(card.proposalId)}/reject`,
      { proposalHash: card.summary.hash },
      null,
    );
  } catch {
    // Transport failure with an unknown server outcome (the reject may
    // already be durable server-side). Hold decision ownership across ONE
    // authoritative re-read instead of relying on the deduped background
    // sync: that sync is dropped while an older sync is still in flight,
    // which would leave the buttons disabled and consume the pending timer.
    showNotice("却下できませんでした。もう一度お試しください");
    await reconcileLostReject(card);
    return;
  }
  card.deciding = false;
  if (posted.status === 200) {
    clearApproveKey(card.proposalId);
    clearPendingExpiry(card.proposalId);
    showNotice("却下しました");
    cards = cards.filter((c) => c.proposalId !== card.proposalId);
    await hydrateHistory();
    return;
  }
  cards = [...cards];
  showNotice("却下できませんでした。内容を確認してください");
  void syncActions();
}

async function reconcileLostReject(card: CardState): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  if (cards.find((c) => c.proposalId === card.proposalId) === undefined) return;
  let current: ProposalSummary | null = null;
  try {
    const listed = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/proposals`,
    );
    const items = (listed.body as { proposals?: unknown }).proposals;
    if (listed.status === 200 && Array.isArray(items) && sessionId === sid) {
      current =
        (items as unknown[]).find(
          (item): item is ProposalSummary =>
            isProposalSummary(item) && item.proposalId === card.proposalId,
        ) ?? null;
    }
  } catch {
    current = null;
  }
  if (cards.find((c) => c.proposalId === card.proposalId) === undefined) return;
  if (
    current !== null &&
    (current.status === "rejected" || current.status === "expired")
  ) {
    card.deciding = false;
    clearApproveKey(card.proposalId);
    removeActionCard(card.proposalId);
    await hydrateHistory();
    return;
  }
  if (current !== null && current.status === "approved") {
    clearPendingExpiry(card.proposalId);
    card.deciding = false;
    card.status = current.status;
    card.summary = current;
    cards = [...cards];
    void watchAction(card.proposalId, current);
    return;
  }
  card.deciding = false;
  if (current !== null && current.status === "pending") {
    card.summary = current;
    card.status = current.status;
    card.deadline = current.expiresAt;
    card.hash = current.hash;
    cards = [...cards];
    schedulePendingExpiry(card.proposalId);
  } else {
    cards = [...cards];
  }
  void syncActions();
}

async function stopAction(card: CardState): Promise<void> {
  if (sessionId === null || card.runId === null) return;
  let posted: { status: number; body: unknown };
  try {
    posted = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(card.runId)}/cancel`,
      {},
      null,
    );
  } catch {
    showNotice("停止できませんでした");
    void syncActions();
    return;
  }
  if (posted.status === 200) {
    if (parseCancelRunStatus(posted.body) === "cancelled") {
      showNotice("停止しました");
      void syncActions();
      return;
    }
    void syncActions();
    return;
  }
  void syncActions();
}

// --- login-expiry UX (Q10): keep draft, inline re-login, same session ---
async function submitLogin(): Promise<void> {
  loginError = "";
  const res = await loginRemote(loginPassword);
  if (res.status === 200) {
    loginPassword = "";
    authExpired = false;
    showNotice("再ログインしました");
    return;
  }
  if (res.status === 429) {
    loginError = "試行回数が多すぎます。しばらく待ってください";
    return;
  }
  loginError = "ログインできませんでした";
}

// --- boot (C06 reload recovery) ---
// Legacy order (client.ts boot): recover/discover first so a held discovery
// gates boot and a recovered run owns the composer BEFORE the final
// hydration; the subscription stays deferred until after hydration so the
// durable history (and its terminal dedup anchor) registers first.
async function bootSession(): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  // Pending-key recovery: accepted keys replay before discovery. The stored
  // idempotency response carries no status; the accepted run is seeded only
  // by live events/status after subscription.
  let descriptor: {
    runId: string;
    turnId: string | null;
    status: string | null;
  } | null = null;
  const pendingKey = lsGet(LS_PENDING_KEY);
  if (pendingKey !== null && pendingKey.length > 0) {
    try {
      const lookup = await fetchJson(
        `/api/sessions/${encodeURIComponent(sid)}/idempotency/${encodeURIComponent(pendingKey)}?scope=${encodeURIComponent(`session:${sid}:message`)}`,
      );
      const body = lookup.body as {
        found?: unknown;
        body?: { turnId?: unknown; run?: { id?: unknown } };
      };
      if (lookup.status === 200 && body.found === true) {
        lsDel(LS_PENDING_KEY);
        const storedRun = body.body?.run;
        const runId =
          typeof storedRun === "object" && storedRun !== null
            ? (storedRun as { id?: unknown }).id
            : null;
        if (typeof runId === "string") {
          descriptor = {
            runId,
            turnId:
              typeof body.body?.turnId === "string" ? body.body.turnId : null,
            status: null,
          };
        }
      } else if (
        lookup.status !== 429 &&
        lookup.status !== 503 &&
        lookup.status < 500
      ) {
        lsDel(LS_PENDING_KEY);
        showNotice("送信を再入力してください");
      }
    } catch {
      showNotice("送信できませんでした。もう一度お試しください");
    }
  }
  if (sessionId !== sid) return;
  // Active-run discovery. A held discovery gates boot here (before
  // hydration); a 404 session or 200 `{run:null}` yields no descriptor.
  if (descriptor === null) {
    try {
      const discovered = await fetchJson(
        `/api/sessions/${encodeURIComponent(sid)}/active-run`,
      );
      if (discovered.status === 200 && sessionId === sid) {
        const run = (discovered.body as { run?: unknown }).run;
        const r = (typeof run === "object" && run !== null ? run : {}) as {
          id?: unknown;
          status?: unknown;
          turnId?: unknown;
        };
        if (
          typeof r.id === "string" &&
          typeof r.status === "string" &&
          ACTIVE_RUN_STATUSES.has(r.status)
        ) {
          descriptor = {
            runId: r.id,
            turnId: typeof r.turnId === "string" ? r.turnId : null,
            status: r.status,
          };
        }
      }
    } catch {
      // Best effort.
    }
  }
  if (sessionId !== sid) return;
  // The recovered run owns the composer BEFORE the final hydration: a
  // held/slow hydration must never expose an enabled Send for a genuinely
  // active run. A discovered non-terminal `cancel_requested` also seeds its
  // 「停止しました」notice here (cursor stays 0, never the discovery
  // `eventSeq`); the actual subscription happens after hydration.
  if (descriptor !== null) {
    if (descriptor.turnId !== null) {
      activeTurnId = descriptor.turnId;
      runTurns.set(descriptor.runId, descriptor.turnId);
    }
    activeRunId = descriptor.runId;
    if (descriptor.status === "cancel_requested") {
      runView = { ...INITIAL_RUN_VIEW, notice: "停止しました" };
      activeRunCursor = 0;
      showNotice("停止しました");
      seededRunId = descriptor.runId;
    }
    // A reload can adopt an m5-action Run as the generic active run. Read
    // its ACTUAL execution marker/cancellability BEFORE the first hydration
    // paint so a post-marker (or terminal) Action never offers Stop.
    await refreshActionRunStops();
  }
  if (sessionId !== sid) return;
  await hydrateHistory();
  if (sessionId !== sid) return;
  await syncActions();
  if (sessionId !== sid) return;
  // The captured run id is subscribed exactly once, even when the run has
  // already completed meanwhile: the durable event backlog renders or
  // dedups, and the terminal view releases the composer normally.
  if (descriptor !== null) {
    subscribe(descriptor.runId);
  }
}

onMount(() => {
  onAuthExpired(() => {
    // Q10: 401 keeps the typed draft (input is untouched), shows the
    // inline re-login, and the session id is retained for resume.
    authExpired = true;
  });
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        sessions = (parsed as unknown[])
          .filter((v): v is string => typeof v === "string")
          .slice(-20);
      }
    }
  } catch {
    sessions = [];
  }
  void (async () => {
    await ensureSession();
    if (sessionId !== null) {
      rememberSession(sessionId);
      await bootSession();
    }
    booted = true;
  })();
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      reconcilePendingExpiry();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    closeStream();
    for (const timer of watchTimers.values()) window.clearInterval(timer);
    watchTimers.clear();
    for (const timer of pendingExpiryTimers.values())
      window.clearTimeout(timer);
    pendingExpiryTimers.clear();
    document.removeEventListener("visibilitychange", onVisibility);
    onAuthExpired(null);
  };
});

function answerPartsForTurn(
  turn: Turn,
): { text: string; citations: string[] }[] {
  if (turn.run === null) return [];
  return runResultToAnswerParts(turn.run.result).map((p) => ({
    text: p.text,
    citations: [...p.citations],
  }));
}

function evidenceForTurn(turn: Turn): {
  before: string | null;
  after: string[];
} {
  if (turn.run === null) return { before: null, after: [] };
  const receipt = turn.run.receipt;
  const outcome =
    receipt !== null &&
    receipt !== undefined &&
    typeof receipt.outcome === "string"
      ? receipt.outcome
      : null;
  const ev = actionEvidenceButtons({
    targetCitation:
      typeof turn.run.targetCitation === "string"
        ? turn.run.targetCitation
        : null,
    outcome,
    result: turn.run.result,
  });
  return { before: ev.before, after: [...ev.after] };
}
</script>

<div class="shell">
  <header class="topbar">
    <h1>会話</h1>
    <div class="sessions">
      <label for="session-list">セッション</label>
      <select
        id="session-list"
        value={sessionId ?? ""}
        onchange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v.length > 0) void switchSession(v);
        }}
        disabled={sending || activeRunId !== null}
      >
        {#if sessionId === null}
          <option value="">読み込み中</option>
        {/if}
        {#each sessions as id (id)}
          <option value={id} selected={id === sessionId}>
            {id === sessionId ? `● ${id.slice(0, 8)}` : id.slice(0, 8)}
          </option>
        {/each}
      </select>
      <button
        id="session-new"
        type="button"
        onclick={() => void newSession()}
        disabled={sending || activeRunId !== null}
      >
        新規作成
      </button>
    </div>
  </header>

  {#if authExpired}
    <section id="login-expired" aria-label="再ログイン">
      <p>ログインの有効期限が切れました。入力中の文章は保持されています。</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void submitLogin();
        }}
      >
        <label>
          パスワード
          <input
            id="relogin-password"
            type="password"
            autocomplete="current-password"
            bind:value={loginPassword}
          />
        </label>
        <button id="relogin-submit" type="submit">再ログイン</button>
      </form>
      {#if loginError.length > 0}
        <p id="relogin-error" role="alert">{loginError}</p>
      {/if}
    </section>
  {/if}

  <main id="conversation" aria-live="polite">
    {#if !booted && turns.length === 0}
      <p>読み込み中…</p>
    {/if}
    {#if hasMoreHistory}
      <button
        id="history-older"
        type="button"
        onclick={() => void loadOlderHistory()}
        disabled={loadingOlder}
      >
        さらに古い履歴を読み込む
      </button>
    {/if}
    {#each turns as turn (turn.turnId.length > 0 ? turn.turnId : `${turn.text ?? ""}-${turns.indexOf(turn)}`)}
      <section
        data-turn-kind={turn.kind ?? ""}
        data-action-history={turn.kind === "action_approval" || turn.kind === "action_rejection"
          ? turn.kind
          : undefined}
      >
        {#if turn.kind === "action_approval" || turn.kind === "action_rejection"}
          {@const receipt = turn.run?.receipt ?? null}
          {@const outcome =
            receipt !== null && typeof receipt.outcome === "string" ? receipt.outcome : null}
          {@const ev = evidenceForTurn(turn)}
          <p>{actionDecisionIntentText(turn.kind, outcome)}</p>
          {#if turn.run !== null}
            {@const rawSummary =
              receipt !== null && typeof receipt.summary === "object" && receipt.summary !== null
                ? (receipt.summary as { summary?: unknown }).summary
                : null}
            {#if typeof rawSummary === "string" && previewDisplay(rawSummary).length > 0}
              <p data-action-receipt="true">{previewDisplay(rawSummary)}</p>
            {:else if receipt === null && typeof turn.run.executionStatus === "string"}
              {@const progress = actionProgressText(turn.run.executionStatus)}
              {#if progress.length > 0}
                <p data-action-progress="true">{progress}</p>
              {/if}
            {/if}
            {#if ev.before !== null}
              {@const beforeCitation = ev.before}
              {@const beforeRunId = turn.run.runId}
              <button
                type="button"
                data-action-evidence="before"
                onclick={() => void openCitation(beforeCitation, beforeRunId)}
              >
                変更前 {beforeCitation}
              </button>
            {/if}
            {#each ev.after as citation (citation)}
              {@const runId = turn.run !== null ? turn.run.runId : undefined}
              <button
                type="button"
                data-action-citation="true"
                data-action-evidence="after"
                aria-label={`確認済みの変更後 ${citation}`}
                onclick={() => void openCitation(citation, runId)}
              >
                {citation}
              </button>
            {/each}
          {/if}
        {:else}
          <p>{turn.text ?? ""}</p>
          {#if turn.run !== null}
            {@const parts = answerPartsForTurn(turn)}
            {@const runId = turn.run.runId}
            {#each parts as part, partIndex (partIndex)}
              <p>{part.text}</p>
              {#each part.citations as citation (citation)}
                <button
                  type="button"
                  aria-label={citation.startsWith("m")
                    ? `この回答の記憶引用 ${citation}`
                    : `保存された引用 ${citation}`}
                  onclick={() => void openCitation(citation, runId)}
                >
                  {citation}
                </button>
              {/each}
            {/each}
          {:else if turn.turnId.length > 0}
            <p>応答なし</p>
          {/if}
        {/if}
      </section>
    {/each}
    {#if retryTurnId !== null}
      {@const tid = retryTurnId}
      <button
        id="history-retry"
        type="button"
        onclick={() => void retry(tid)}
      >
        もう一度生成
      </button>
    {/if}
    {#if liveVisible}
      {@const runId = [...renderedAnswers].pop()}
      <section data-live-answer="true">
        {#each liveAnswer as part, partIndex (partIndex)}
          <p>{part.text}</p>
          {#each part.citations as citation (citation)}
            <button
              type="button"
              aria-label={citation.startsWith("m")
                ? `この回答の記憶引用 ${citation}`
                : `保存された引用 ${citation}`}
              onclick={() => void openCitation(citation, runId)}
            >
              {citation}
            </button>
          {/each}
        {/each}
      </section>
    {/if}
    {#each cards as card (card.proposalId)}
      {@const model = cardModel(card)}
      <section
        data-action-card="true"
        data-action-tool={card.summary.tool}
        data-action-state={model.expired
          ? "expired"
          : card.summary.status === "pending"
            ? "pending"
            : (card.view?.status ?? card.summary.status)}
        data-action-marker={card.view?.markerCommitted === true ? "committed" : "uncommitted"}
        aria-label="承認カード"
      >
        <p>{card.summary.tool === "calendar.create" ? "予定作成の確認" : "日程変更の確認"}</p>
        {#if card.summary.tool === "calendar.create" && card.summary.input.title !== undefined}
          <p data-action-title="true">件名: {card.summary.input.title}</p>
        {/if}
        <p data-action-start="true">開始: {card.summary.input.start}</p>
        <p data-action-end="true">終了: {card.summary.input.end}</p>
        <p data-action-deadline="true">確認期限: {formatInstant(card.summary.expiresAt)}</p>
        <p data-action-hash="true">ハッシュ: {card.summary.hash}</p>
        <p data-action-preview="true">{previewDisplay(card.summary.preview.summary)}</p>
        <p data-action-progress="true">{model.progressText}</p>
        <p data-action-outcome="true">{model.outcomeText !== "" ? model.outcomeText : card.errorText}</p>
        <p data-action-evidence="card">
          {#if card.view !== null && typeof card.view.targetCitation === "string"}
            {@const beforeCitation = card.view.targetCitation}
            {@const runId = typeof card.view.runId === "string" ? card.view.runId : undefined}
            <button
              type="button"
              data-action-evidence="before"
              onclick={() => void openCitation(beforeCitation, runId)}
            >
              変更前 {beforeCitation}
            </button>
          {/if}
        </p>
        {#if model.decisionVisible}
          <button
            id="action-approve"
            type="button"
            data-action-approve="true"
            disabled={card.deciding}
            onclick={() => void approve(card)}
          >
            承認
          </button>
          <button
            id="action-reject"
            type="button"
            data-action-reject="true"
            disabled={card.deciding}
            onclick={() => void reject(card)}
          >
            却下
          </button>
        {/if}
        {#if model.stopVisible}
          <button
            type="button"
            data-action-stop="true"
            disabled={card.deciding}
            onclick={() => void stopAction(card)}
          >
            中断
          </button>
        {/if}
      </section>
    {/each}
  </main>

  <div
    id="drawer"
    role="dialog"
    aria-label="引用"
    hidden={!drawerOpen}
    onclick={(e) => {
      if (e.target === e.currentTarget) closeDrawer();
    }}
  >
    <pre id="drawer-body">{drawerBody}</pre>
    <button type="button" onclick={closeDrawer}>閉じる</button>
  </div>

  {#if degradedMemory}
    <p id="memory-degraded" role="status">記憶なしで続行しています</p>
  {/if}

  <p id="composer-notice" aria-live="polite">{notice}</p>
  <form
    id="composer"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <input
      id="composer-input"
      type="text"
      autocomplete="off"
      bind:value={input}
    />
    <button id="composer-send" type="submit" disabled={composerSendDisabled()}>
      送信
    </button>
    <button
      id="composer-stop"
      type="button"
      hidden={!composerStopVisible()}
      disabled={!composerStopVisible()}
      onclick={() => void stop()}
    >
      停止
    </button>
  </form>
</div>

<style>
  @import "./app.css";
</style>
