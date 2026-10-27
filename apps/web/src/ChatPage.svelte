<script lang="ts">
import { onMount, type Snippet, tick } from "svelte";
import {
  errorCode,
  fetchJson,
  loginRemote,
  onAuthExpired,
  postJson,
  randomUuid,
} from "./lib/api.js";
import { autogrowTextarea, shouldSendOnKeydown } from "./lib/composer.js";
import {
  appendDraftText,
  DRAFT_LABEL,
  type DraftState,
  draftDisplayText,
} from "./lib/draft.js";
import FeatureNav from "./lib/FeatureNav.svelte";
import Markdown from "./lib/Markdown.svelte";
import {
  type ChatProposalCardView,
  conversationProposalCards,
  createProposalSyncGuard,
  type FrozenProposalDecision,
  frozenProposalDecision,
  type ParentPurposeSnapshot,
  proposalCardErrorText,
  trialProposalCards,
} from "./lib/proposal_cards.js";
import {
  ACTION_PROGRESS_TEXT,
  type AnswerPartView,
  actionCardModel,
  actionDecisionIntentText,
  actionErrorCodeText,
  actionEvidenceButtons,
  applyRunEvent,
  type ExecutionStatus,
  INITIAL_RUN_VIEW,
  isCorruptCursor,
  isRetryableTurnKind,
  type ProposalStatus,
  parseCancelRunStatus,
  type ReceiptOutcome,
  type RunViewState,
  runResultToAnswerParts,
} from "./lib/reducer.js";
import { setSessionId } from "./lib/session.svelte.js";
import {
  appendThinkingText,
  applyThinkingUsage,
  deriveRunPhase,
  durableRunStart,
  EMPTY_THINKING,
  formatElapsedSuffix,
  formatPhaseText,
  formatThinkingStats,
  type ThinkingState,
  thinkingDisplayText,
} from "./lib/thinking.js";

// PR-5: the chat shell also hosts the first native feature page. `activePath`
// keeps the shared nav honest about the current route, and `children` is the
// feature panel slot (memory today; later pages slot in the same way).
let {
  activePath = "/",
  children,
}: { activePath?: string; children?: Snippet } = $props();

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
  status: ExecutionStatus | null;
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
let liveAnswer: AnswerPartView[] = $state([]);
let liveVisible = $state(false);
// Per-answer「原文」/「話し方」 toggle (keyed by run id). Default is voiced
// whenever the completed RunResult carries a rendered voice projection.
let canonicalAnswers: Record<string, boolean> = $state({});
// PR-3 thinking/status (frontend plan §11.1 Q11): ephemeral reasoning
// text lives in memory only (never persisted, never sent back). The
// block expands while reasoning streams and auto-collapses on answer;
// the phase line derives from durable events only (reload-safe).
let thinking: ThinkingState = $state({ ...EMPTY_THINKING });
let thinkingCollapsed = $state(false);
let showThinking = $state(false);
// V4 composer (upstream ChatFormInputBasic): textarea autoresize + IME
// guard. `composing` mirrors the IME composition session so Enter during
// Japanese conversion never submits (keydown `isComposing` is the primary
// signal; the flag covers browsers that only fire composition events).
let composing = $state(false);
// Safari IME: the Enter keydown that immediately follows `compositionend`
// arrives with `isComposing === false` yet must not submit. Set on
// `compositionend`, cleared on the next tick (both event orders covered;
// unit-tested via `justEndedComposition` in composer.test.ts).
let justEndedComposition = $state(false);
let composerEl: HTMLTextAreaElement | null = $state(null);
let runStartedAt = $state(0);
let elapsedSec = $state(0);
// PR #82 review (4312961764): cancellation requested but the run still
// reports "generating" (watchdog not yet settled). The phase line is
// hidden while this is set — the「停止しました」notice already tells the
// user the stop was accepted, and a non-cooperative strategy must not
// keep「考え中…/ツール実行中…」alive beside it.
let cancelPending = $state(false);
// PR-4 provisional draft (ephemeral, memory-only, never persisted/sent).
let draft: DraftState | null = $state(null);
// PR78 review: run ids whose draft must never (re)appear. A reload-adopted
// run clears its draft once; later `answer.draft.delta` frames for it are
// ignored, and `run.cancel_requested` / a successful cancel POST discard
// the draft even while the run still reports "generating".
const draftSuppressedRuns = new Set<string>();
let elapsedTimer: number | null = null;
let retryTurnId: string | null = $state(null);
let drawerOpen = $state(false);
let drawerBody = $state("");
// Slice ③ web citation drawer: only references whose detail carries a
// verified http(s) `webResultUrl` (connector kind `web`) render the
// external-link block. The URL is re-validated client-side; nothing else
// ever becomes an <a href>.
let drawerWeb: {
  title: string;
  url: string;
} | null = $state(null);
// Web citation chip labels (title bounded + host), hydrated lazily from the
// stored reference detail. Memory-only (never persisted); the version tick
// is the reactive dependency the template reads.
let chipMeta = new Map<string, string>();
let chipMetaVersion = $state(0);
const chipHydrationDone = new Set<string>();
let cards: CardState[] = $state([]);
// Chat proposal cards (conversation + trial). Read-only projections of the
// existing list endpoints; every decision is an explicit human click.
let proposalCards: ChatProposalCardView[] = $state([]);
let proposalDeciding = $state<string | null>(null);
let proposalNotice = $state("");
// Frozen retry state for the keyed card decisions: an uncertain reply keeps
// the SAME Idempotency-Key + body until a definitive 2xx/4xx arrives.
let pendingCardDecision: FrozenProposalDecision<unknown> | null = null;
// Generation guard: only the latest syncProposals() may apply its result.
const proposalSync = createProposalSyncGuard();
let authExpired = $state(false);
let loginPassword = $state("");
let loginError = $state("");
let degradedMemory = $state(false);

let sse: EventSource | null = null;
let fallbackTimer: number | null = null;
// V2 llama-like list: the transcript is a scroll container pinned to the
// bottom. New content auto-scrolls unless the user scrolled up; sending
// re-pins. `scrollEl`/`stickToBottom` are view-only (no message state).
let scrollEl: HTMLElement | null = $state(null);
let stickToBottom = $state(true);
let runChain: Promise<void> = Promise.resolve();
let renderedAnswers = $state(new Set<string>());
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
    typeof r.proposalId === "string" &&
    typeof r.hash === "string" &&
    typeof r.status === "string" &&
    typeof r.expiresAt === "number"
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

function isActionRun(runId: string): boolean {
  // PR #82 review (4312961798): a reload-adopted m5-action run emits no
  // model/tool phase events, so the generic phase line would show a
  // phantom「考え中…」beside the action card. Action runs are exactly the
  // entries in the execution Stop map (populated before subscribe on boot).
  return actionRunStops.has(runId);
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
      // Shared reactive store: feature panels rebind on this change.
      setSessionId(stored);
      return;
    }
    if (probeStatus === 404 || probeStatus === 410) {
      // The stored session is gone: clear it in ONE place (store + durable
      // localStorage mirror) so no panel rebinds onto the dead id.
      setSessionId(null);
    } else {
      sessionId = stored;
      setSessionId(stored);
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
  setSessionId(body.sessionId);
  rememberSession(body.sessionId);
}

async function switchSession(id: string): Promise<void> {
  if (id === sessionId || sending || activeRunId !== null) return;
  closeStream();
  sessionId = id;
  setSessionId(id);
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
  setSessionId(body.sessionId);
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
  thinking = { ...EMPTY_THINKING };
  thinkingCollapsed = false;
  showThinking = false;
  draft = null;
  draftSuppressedRuns.clear();
  stopElapsedTimer();
  elapsedSec = 0;
  cancelPending = false;
  retryTurnId = null;
  renderedAnswers = new Set();
  terminalHydrated = new Set();
  turnKinds = new Map();
  runTurns = new Map();
  pendingRequest = null;
  for (const timer of pendingExpiryTimers.values()) window.clearTimeout(timer);
  pendingExpiryTimers = new Map();
  cards = [];
  // Proposal cards are session-scoped too, and an in-flight sync/decision
  // from the previous session must not leak into the new one (review #154).
  proposalSync.invalidate();
  proposalCards = [];
  proposalDeciding = null;
  proposalNotice = "";
  pendingCardDecision = null;
  actionRunStops = new Map();
  degradedMemory = false;
  notice = "";
  // A fresh session starts pinned to the bottom (review #84): without
  // this the flag carries the previous session's scrolled-up state and
  // new content never auto-scrolls.
  stickToBottom = true;
  // Invalidate and close any citation drawer from the previous session:
  // the seq bump also drops in-flight openCitation responses (review PR75).
  citationSeq += 1;
  drawerOpen = false;
  drawerBody = "";
  // Session-scoped citation data must not survive a session switch/creation:
  // clear the hydrated web block alongside the drawer body (review PR112).
  drawerWeb = null;
}

// --- PR-3 thinking/status helpers (ephemeral deltas + durable phase) ---
function stopElapsedTimer(): void {
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function startElapsedTimer(fromMs?: number): void {
  stopElapsedTimer();
  // PR77 review: when a durable run start is known (reload/resubscribe),
  // seed the timer from it so a minutes-old run is not shown as newly
  // started; a fresh subscription starts from now.
  runStartedAt = typeof fromMs === "number" && fromMs > 0 ? fromMs : Date.now();
  elapsedSec =
    runStartedAt === Date.now()
      ? 0
      : Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
  elapsedTimer = window.setInterval(() => {
    if (activeRunId === null) {
      stopElapsedTimer();
      return;
    }
    elapsedSec = Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
  }, 500);
}

/**
 * Phase/status line text (durable events only; empty when not running).
 * PR #82 review (4312961770): the elapsed seconds are NOT part of this
 * live-announced text — they render in a separate aria-hidden span so the
 * once-per-second tick never re-announces the phase line.
 */
function runStatusText(): string {
  if (activeRunId === null || runView.visible !== "generating") {
    return "";
  }
  const phase = deriveRunPhase({
    toolRequested: runView.toolRequested,
    toolCompleted: runView.toolCompleted,
    stepsCompleted: runView.stepsCompleted,
  });
  return formatPhaseText(
    phase,
    runView.toolNames,
    runView.toolRequested,
    runView.toolCompleted,
  );
}

/** Ephemeral PR-2 delta envelope (seq 0: never a cursor, never stored). */
function isEphemeralDelta(event: { seq: number; type: string }): boolean {
  return (
    event.seq === 0 ||
    event.type === "model.reasoning.delta" ||
    event.type === "model.usage" ||
    event.type === "answer.draft.delta"
  );
}

/**
 * Apply one ephemeral delta to memory-only thinking/draft state. Never
 * touches the durable cursor, never persists, never sends anything back.
 * `answer.draft.delta` accumulates the provisional draft (PR-4); a new
 * step restarts the text, the validated answer/failure/cancel discards it.
 */
function applyEphemeralDelta(
  runId: string,
  event: { type: string; payload: unknown },
): void {
  if (activeRunId !== runId || runView.visible !== "generating") {
    return;
  }
  if (event.type === "model.reasoning.delta") {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as { text?: unknown }).text
        : null;
    const hadText = thinking.text.length > 0;
    thinking = appendThinkingText(thinking, payload);
    if (!hadText && thinking.text.length > 0) {
      // llama.cpp-style: expanded while streaming; the user toggle wins
      // afterwards and the answer auto-collapses the block.
      showThinking = true;
      thinkingCollapsed = false;
    }
    return;
  }
  if (event.type === "model.usage") {
    thinking = applyThinkingUsage(thinking, event.payload);
    return;
  }
  if (event.type === "answer.draft.delta") {
    // PR78 review: an adopted/reloaded run's draft is dropped once and
    // never rebuilt from later delta frames (the bubble must not reappear).
    if (draftSuppressedRuns.has(runId)) {
      return;
    }
    // Provisional unvalidated text: same-step appends, new-step restarts.
    draft = appendDraftText(draft, event.payload);
  }
}

/**
 * PR78 review: `run.cancel_requested` keeps `runView.visible` "generating"
 * until the cancellation watchdog emits the terminal event, so the old
 * draft would stay visible (and a non-cooperative gateway could keep
 * feeding deltas). Discard the draft and suppress later delta frames as
 * soon as cancellation is requested; also called right after a successful
 * cancel POST. PR #82 review (4312961764): the same paths mark the run
 * cancel-pending so the phase line stops rendering/incrementing while the
 *「停止しました」notice is up.
 */
function discardDraftOnCancelRequested(runId: string, type: string): void {
  if (type !== "run.cancel_requested" || activeRunId !== runId) {
    return;
  }
  cancelPending = true;
  draft = null;
  draftSuppressedRuns.add(runId);
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
  if (typeof r.turnId !== "string") return null;
  const sel = r.selectedRun;
  let run: HistoryRun | null = null;
  if (typeof sel === "object" && sel !== null) {
    const s = sel as Record<string, unknown>;
    if (typeof s.runId === "string") {
      const receipt = s.receipt;
      run = {
        runId: s.runId,
        result: s.result ?? null,
        receipt:
          typeof receipt === "object" && receipt !== null
            ? (receipt as NonNullable<HistoryRun["receipt"]>)
            : null,
        executionStatus:
          typeof s.executionStatus === "string" ? s.executionStatus : null,
        targetCitation: s.targetCitation ?? null,
      };
    }
  }
  // exactOptionalPropertyTypes: absent optional props are omitted, never
  // explicitly `undefined` (svelte-check).
  const turn: Turn = { turnId: r.turnId, run };
  if (typeof r.kind === "string") turn.kind = r.kind;
  if (typeof r.text === "string") turn.text = r.text;
  return turn;
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
    // Optimistic user bubble (§16.2). A fresh send re-pins the V2 list.
    stickToBottom = true;
    turns = [...turns, { turnId: "", kind: "user_text", text, run: null }];
    input = "";
    // Resize only after the cleared value reaches the DOM, otherwise the
    // textarea keeps its grown height with stale scrollHeight. Then keep
    // the transcript pinned while the composer shrinks.
    await tick();
    autogrowTextarea(composerEl);
    if (stickToBottom && scrollEl !== null) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
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
  const runId = activeRunId;
  const posted = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {},
    null,
  );
  if (posted.status < 200 || posted.status >= 300) {
    showNotice("停止できませんでした");
    return;
  }
  // PR78 review: once the cancel POST is accepted, discard the draft and
  // suppress later deltas immediately — do not wait for the terminal
  // event, which a non-cooperative strategy can delay for seconds while
  // the run still reports "generating".
  if (activeRunId === runId) {
    // PR #82 review (4312961764): the stop was accepted; hide the phase
    // line immediately instead of counting seconds beside「停止しました」.
    cancelPending = true;
    draft = null;
    draftSuppressedRuns.add(runId);
  }
  if (actionRunStops.has(runId)) {
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
  stopElapsedTimer();
  if (activeRunId !== null) {
    // PR78 review: the terminal released the run; a later run must not
    // inherit this run's draft suppression.
    draftSuppressedRuns.delete(activeRunId);
  }
  activeRunId = null;
  activeTurnId = null;
  // Native feature-page seam (legacy run-settled hook parity): listeners
  // (e.g. the native learning panel) re-read their quiet lists here.
  try {
    window.dispatchEvent(new CustomEvent("ch:run-settled"));
  } catch {
    // Best effort: teardown never breaks the chat page.
  }
}

function subscribe(runId: string): void {
  void subscribeRun(runId);
}

async function subscribeRun(runId: string): Promise<void> {
  if (sessionId === null) return;
  closeStream();
  activeRunId = runId;
  retryTurnId = null;
  // Ephemeral thinking state is memory-only: every (re)subscribe starts
  // fresh (a reload loses the text by construction; only durable events
  // rebuild the phase line).
  thinking = { ...EMPTY_THINKING };
  thinkingCollapsed = false;
  showThinking = false;
  draft = null;
  startElapsedTimer();
  const stored = readStoredCursor(runId);
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
    cancelPending = false;
    if (stored !== null && stored > 0) {
      // PR77 review: a stored cursor means the stream resumes mid-run
      // (page reload). Before another durable event creates a gap and
      // triggers catch-up, the zeroed projection would derive 「考え中…」
      // even when the persisted events show an outstanding tool.requested.
      // Seed the elapsed timer from the run's durable start and rebuild
      // the phase projection from history (up to the stored cursor, so
      // the native stream keeps delivering newer events; reducer dedup
      // keeps any overlap exactly-once).
      const resynced = await validateStoredCursor(runId, stored);
      if (resynced || activeRunId !== runId || sessionId === null) return;
      const rebuilt = await rebuildResumedProjection(runId, stored);
      if (rebuilt && activeRunId !== runId) return;
    } else {
      // PR #82 review (4312961778): a recovered run without a usable
      // cursor (first event not yet persisted, storage failed/cleared)
      // must still show the true elapsed time — the replayed events carry
      // no start timestamp. Seed the timer from the status endpoint's
      // durable start; projection replay stays cursor-gated. A fresh run
      // resolves to ~now and keeps the previous behaviour.
      const durableStart = await fetchDurableRunStart(runId);
      if (activeRunId !== runId || sessionId === null) return;
      if (durableStart !== null) {
        startElapsedTimer(durableStart);
      }
    }
  }
  showNotice(runView.notice);
  const sid = sessionId;
  const query = stored !== null && stored > 0 ? `?after=${stored}` : "";
  const url = `/api/sessions/${encodeURIComponent(sid)}/runs/${encodeURIComponent(runId)}/events/stream${query}`;
  let opened = false;
  let sseErrorStreak = 0;
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
    sseErrorStreak = 0;
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
      return;
    }
    // After the stream has opened, the one-shot pre-open fallback timer
    // can never fire again: a nonterminal native reconnect loop (e.g. a
    // remote session expiring into HTTP 401) would otherwise retry
    // forever and fetchJson() would never see the failure. Count
    // consecutive errors without an intervening event and switch to the
    // JSON fallback polling so the 401 reaches the inline re-login UI
    // (review PR75 4310874681).
    sseErrorStreak += 1;
    if (sseErrorStreak >= SSE_ERROR_FALLBACK_LIMIT) {
      closeStream();
      void pollFallback(runId);
    }
  };
}

/**
 * Status-endpoint fetch for the durable run start (PR #82 review
 * 4312961778). Best effort: any failure/shape mismatch keeps the current
 * (subscription-instant) timer.
 */
async function fetchDurableRunStart(runId: string): Promise<number | null> {
  if (sessionId === null || activeRunId !== runId) return null;
  try {
    const fetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/status`,
    );
    if (activeRunId !== runId || fetched.status !== 200) return null;
    const run = (fetched.body as { run?: unknown }).run;
    return durableRunStart(run);
  } catch {
    return null;
  }
}

/**
 * Cursor validation on resume + durable elapsed-time seed (PR77 review).
 * Returns true when a corrupt cursor triggered a resync + re-subscribe (the
 * caller must not open another stream for the stale cursor).
 */
async function validateStoredCursor(
  runId: string,
  cursor: number,
): Promise<boolean> {
  if (sessionId === null || cursor <= 0 || activeRunId !== runId) return false;
  let fetched: { status: number; body: unknown };
  try {
    fetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/status`,
    );
  } catch {
    return false;
  }
  if (activeRunId !== runId || fetched.status !== 200) return false;
  const run = (fetched.body as { run?: unknown }).run;
  if (typeof run !== "object" || run === null) return false;
  const r = run as {
    id?: unknown;
    eventSeq?: unknown;
  };
  if (r.id !== runId || typeof r.eventSeq !== "number") return false;
  if (isCorruptCursor(cursor, r.eventSeq)) {
    await resyncFromHistory(runId);
    if (sessionId !== null) subscribe(runId);
    return true;
  }
  // Durable run timing (additive status fields, PR77 review): seed the
  // elapsed timer from the real run start instead of the subscription
  // instant, so a reloaded page no longer shows a minutes-old run as new.
  const durableStart = durableRunStart(run);
  if (durableStart !== null && activeRunId === runId) {
    startElapsedTimer(durableStart);
  }
  return false;
}

/**
 * PR77 review: rebuild the durable phase projection by replaying the run's
 * event history from the beginning up to the stored resume cursor, so the
 * status line derives from the persisted tool.requested/tool.completed/step
 * counters instead of zeroed ones (no phantom 「考え中…」 while a tool is
 * outstanding). Events past `upto` stay the native stream's responsibility
 * (the C06 native-terminal-frame race), so this drain stops at the cursor;
 * a best-effort failure keeps the zeroed view and the stream's
 * needs-catchup path converges afterwards.
 */
async function rebuildResumedProjection(
  runId: string,
  upto: number,
): Promise<boolean> {
  if (sessionId === null) return false;
  let cursor = 0;
  for (let page = 0; page < 20; page += 1) {
    if (cursor > upto) break;
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
    for (const item of body.events) {
      if (typeof item.seq !== "number" || typeof item.type !== "string")
        continue;
      if (item.seq > upto) break;
      if (activeRunId !== runId) return false;
      discardDraftOnCancelRequested(runId, item.type);
      const applied = applyRunEvent(
        { ...runView, cursor: activeRunCursor },
        { seq: item.seq, type: item.type, payload: item.payload },
      );
      if (applied.outcome.kind === "ignored-duplicate") continue;
      if (applied.outcome.kind === "needs-catchup") return true;
      if (applied.outcome.kind === "ignored-unknown") {
        activeRunCursor = applied.state.cursor;
        storeCursor(runId, applied.state.cursor);
        continue;
      }
      runView = applied.state;
      activeRunCursor = applied.state.cursor;
      storeCursor(runId, applied.state.cursor);
    }
    cursor = typeof body.nextAfter === "number" ? body.nextAfter : cursor + 1;
    if (body.events.length === 0) break;
  }
  if (activeRunId !== runId) return false;
  // One repaint after the rebuild: the derived phase line now matches the
  // persisted events; a replayed terminal renders and releases the run
  // exactly once (guarded by renderedAnswers/terminalHydrated).
  renderRunView(runId);
  return true;
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
  // PR78 review: cancellation discards the draft immediately, even while
  // the run still renders "generating" (non-cooperative hold-cancel path).
  discardDraftOnCancelRequested(runId, event.type);
  // Ephemeral deltas bypass the durable reducer entirely: no cursor, no
  // persistence, no catch-up. Deltas arriving after the terminal stay
  // dropped (the validated answer is authoritative).
  if (isEphemeralDelta(event)) {
    applyEphemeralDelta(runId, event);
    return;
  }
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
      discardDraftOnCancelRequested(runId, item.type);
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
// Consecutive post-open EventSource errors without an intervening event
// before the JSON fallback takes over (review PR75 4310874681).
const SSE_ERROR_FALLBACK_LIMIT = 3;

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
    // The answer auto-collapses the Thinking block (user can re-open).
    thinkingCollapsed = true;
    // PR-4: the validated structured answer REPLACES the provisional
    // draft completely (the draft label vanishes with the draft text).
    draft = null;
    if (renderedAnswers.has(runId)) {
      finishActiveRun();
      if (!terminalHydrated.has(runId)) {
        terminalHydrated.add(runId);
        void hydrateHistory().then(() => {
          void syncActions();
          void syncProposals();
        });
      }
      return;
    }
    renderedAnswers.add(runId);
    const voiced = runResultToAnswerParts(runView.result, {
      preferVoice: true,
    });
    liveAnswer = (voiced.length > 0 ? voiced : runView.answer).map((p) => ({
      text: p.text,
      citations: [...p.citations],
      ...(p.canonicalText === undefined
        ? {}
        : { canonicalText: p.canonicalText }),
      ...(p.voicedText === undefined ? {} : { voicedText: p.voicedText }),
    }));
    liveVisible = true;
    finishActiveRun();
    if (!terminalHydrated.has(runId)) {
      terminalHydrated.add(runId);
      void hydrateHistory().then(() => {
        void checkDegradedMemory(runId);
        void syncActions();
        void syncProposals();
      });
    }
    return;
  }
  if (runView.visible === "failed") {
    // PR-4: a failed run discards the provisional draft.
    draft = null;
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
        void syncProposals();
      });
    }
    return;
  }
  if (runView.visible === "stopped") {
    // PR-4: a cancelled run discards the provisional draft.
    draft = null;
    showNotice("停止しました");
    finishActiveRun();
    if (!terminalHydrated.has(runId)) {
      terminalHydrated.add(runId);
      void hydrateHistory().then(() => {
        void syncActions();
        void syncProposals();
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

/** Chip text for one citation: hydrated web chips show rN + title（host）. */
function chipLabel(citation: string): string {
  void chipMetaVersion;
  const key = `${sessionId ?? ""}:${citation}`;
  return chipMeta.get(key) ?? citation;
}

/**
 * Lazily resolve a batch of rN citations against the stored references.
 * Only web-backed references (detail `webResultUrl`, scheme http/https) get
 * a hydrated label; everything else keeps the plain rN text. The whole
 * batch shares ONE `/references` listing fetch — per-citation listings
 * would transfer and scan the full unpaginated list N times per boot
 * (PR112 review). One attempt per citation per session (failures for the
 * chip only; transient list/detail failures stay retriable, never fatal).
 */
const chipHydrationInFlight = new Set<string>();

async function hydrateChips(citations: string[], sid: string): Promise<void> {
  const ordinalOf = (citation: string): number => Number(citation.slice(1));
  const keyOf = (citation: string): string => `${sid}:${citation}`;
  const pending: string[] = [];
  for (const citation of citations) {
    if (!/^r[1-9][0-9]*$/.test(citation)) continue;
    const key = keyOf(citation);
    if (chipHydrationDone.has(key) || chipHydrationInFlight.has(key)) continue;
    chipHydrationInFlight.add(key);
    pending.push(citation);
  }
  if (pending.length === 0) return;
  const release = (citation: string, done: boolean): void => {
    const key = keyOf(citation);
    chipHydrationInFlight.delete(key);
    if (done) chipHydrationDone.add(key);
  };
  // The scheme allowlist is enforced twice (repository + here): the chip and
  // the drawer link are only ever built from http(s) URLs.
  const isHttp = (raw: unknown): raw is string =>
    typeof raw === "string" && /^https?:\/\//.test(raw);
  const base = `/api/sessions/${encodeURIComponent(sid)}/references`;
  let listed: { status: number; body: unknown };
  try {
    // Shared listing: one fetch + one ordinal scan for the whole batch.
    listed = await fetchJson(base);
  } catch {
    // Transient network failure: leave every key retriable so the next
    // effect re-run retries the shared listing (PR112 review).
    for (const citation of pending)
      chipHydrationInFlight.delete(keyOf(citation));
    return;
  }
  const rawItems = (listed.body as { items?: unknown }).items;
  const byOrdinal = new Map<number, string>();
  for (const item of (Array.isArray(rawItems) ? rawItems : []) as Array<{
    id?: unknown;
    ordinal?: unknown;
  }>) {
    if (typeof item.ordinal === "number" && typeof item.id === "string") {
      // Exact ordinal match = `r${ordinal}` (same rule as before batching).
      byOrdinal.set(item.ordinal, item.id);
    }
  }
  // Listing miss (non-200 or unknown ordinal) is terminal: not a stored
  // web reference, the chip keeps its plain rN text.
  const resolvable = pending.filter((citation) => {
    if (byOrdinal.has(ordinalOf(citation))) return true;
    release(citation, true);
    return false;
  });
  await Promise.all(
    resolvable.map(async (citation) => {
      const key = keyOf(citation);
      const referenceId = byOrdinal.get(ordinalOf(citation)) as string;
      let webUrl: string | null = null;
      let title = "";
      try {
        const detail = await fetchJson(
          `${base}/${encodeURIComponent(referenceId)}`,
        );
        if (detail.status === 200) {
          const body = detail.body as {
            webResultUrl?: unknown;
            resource?: { title?: unknown };
          };
          webUrl = isHttp(body.webResultUrl) ? body.webResultUrl : null;
          if (webUrl !== null) {
            title =
              typeof body.resource?.title === "string"
                ? body.resource.title
                : "";
          }
        }
        if (detail.status !== 200) {
          // Transient failure (401, reconnect, ...): leave the key retriable.
          // A later effect re-run (e.g. after re-login in bootSession) retries
          // the request instead of stranding the chip as a plain rN (PR112).
          chipHydrationInFlight.delete(key);
          return;
        }
      } catch {
        // Transient network failure: keep the key retriable (PR112 review).
        chipHydrationInFlight.delete(key);
        return;
      }
      if (webUrl === null) {
        release(citation, true);
        return;
      }
      let host = "";
      try {
        host = new URL(webUrl).host;
      } catch {
        release(citation, true);
        return;
      }
      // Title bound is by Unicode code point (matches the web title contract):
      // UTF-16 code units would truncate astral chars (emoji) early and can
      // cut after an unmatched high surrogate (PR112 review).
      const titleChars = Array.from(title);
      const boundedTitle =
        titleChars.length > 32 ? `${titleChars.slice(0, 32).join("")}…` : title;
      chipMeta.set(
        key,
        `${citation}${titleChars.length > 0 ? ` ${boundedTitle}` : ""}（${host}）`,
      );
      chipMetaVersion += 1;
      release(citation, true);
    }),
  );
}

// Hydrate web chips for every visible rN citation (transcript + live
// answer). Re-runs as those reactive sources change; each visible batch
// shares one references listing, and per-citation hydration is attempted
// exactly once.
$effect(() => {
  const sid = sessionId;
  if (sid === null) return;
  const citations = new Set<string>();
  for (const turn of turns) {
    for (const part of answerPartsForTurn(turn)) {
      for (const citation of part.citations) {
        citations.add(citation);
      }
    }
  }
  for (const part of liveAnswer) {
    for (const citation of part.citations) {
      citations.add(citation);
    }
  }
  if (citations.size === 0) return;
  void hydrateChips([...citations], sid);
});

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
  drawerWeb = null;
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
  // Web reference drawer (slice ③): verified stored URL + resource title.
  // Scheme allowlist enforced twice (repository + here) so only http(s)
  // URLs ever become link targets; the visible link text is the full URL.
  // The snapshot itself is rendered once in `#drawer-body` only: production
  // web snapshots already persist `title\nsnippet`, so repeating it as a
  // second "snippet" paragraph duplicated the full evidence and showed the
  // title three times (PR112 review).
  const webBody = detail.body as {
    webResultUrl?: unknown;
    resource?: { title?: unknown };
  };
  drawerWeb =
    typeof webBody.webResultUrl === "string" &&
    /^https?:\/\//.test(webBody.webResultUrl)
      ? {
          title:
            typeof webBody.resource?.title === "string"
              ? webBody.resource.title
              : "",
          url: webBody.webResultUrl,
        }
      : null;
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
  drawerWeb = null;
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
    start: summary.input.start,
    end: summary.input.end,
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

/**
 * Run ids visible in the current session projection: durable history runs
 * plus the live/adopted run. Conversation proposals are only shown when
 * their source run is one of these (no cross-visit leakage).
 */
function knownRunIds(): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.run !== null) ids.add(turn.run.runId);
  }
  for (const runId of runTurns.keys()) ids.add(runId);
  if (activeRunId !== null) ids.add(activeRunId);
  return ids;
}

function proposalListItems(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

function isConversationProposalItem(
  value: unknown,
): value is Parameters<typeof conversationProposalCards>[0][number] {
  if (typeof value !== "object" || value === null) return false;
  const item = value as {
    id?: unknown;
    status?: unknown;
    version?: unknown;
  };
  return (
    typeof item.id === "string" &&
    typeof item.status === "string" &&
    typeof item.version === "number"
  );
}

function isTrialProposalItem(
  value: unknown,
): value is Parameters<typeof trialProposalCards>[0][number] {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; status?: unknown };
  return typeof item.id === "string" && typeof item.status === "string";
}

/**
 * Readonly parent-purpose snapshots for the staged `task` proposals about to
 * be rendered, from the same endpoint the Proposals panel uses. A failed or
 * malformed read stores null, which leaves 採用する disabled (fail closed).
 */
async function loadParentSnapshots(
  sid: string,
  items: readonly Parameters<typeof conversationProposalCards>[0][number][],
  runIds: ReadonlySet<string>,
): Promise<Map<string, ParentPurposeSnapshot | null>> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.status !== "pending" || item.target !== "task") continue;
    if (typeof item.sourceRunId !== "string") continue;
    if (!runIds.has(item.sourceRunId)) continue;
    if (
      typeof item.parentPurposeId === "string" &&
      item.parentPurposeId !== ""
    ) {
      ids.add(item.parentPurposeId);
    }
  }
  const parents = new Map<string, ParentPurposeSnapshot | null>();
  await Promise.all(
    [...ids].map(async (parentId) => {
      let snapshot: ParentPurposeSnapshot | null = null;
      try {
        const res = await fetchJson(
          `/api/sessions/${encodeURIComponent(sid)}/purposes/${encodeURIComponent(parentId)}`,
        );
        if (
          res.status === 200 &&
          typeof res.body === "object" &&
          res.body !== null
        ) {
          const body = res.body as {
            statement?: unknown;
            version?: unknown;
            status?: unknown;
          };
          if (
            typeof body.statement === "string" &&
            typeof body.version === "number" &&
            typeof body.status === "string"
          ) {
            snapshot = {
              statement: body.statement,
              version: body.version,
              status: body.status,
            };
          }
        }
      } catch {
        snapshot = null;
      }
      parents.set(parentId, snapshot);
    }),
  );
  return parents;
}

/**
 * Read-only refresh of the chat proposal cards from the existing session
 * list endpoints. Called after run completion and after every card button;
 * a missing/disabled endpoint simply yields no cards.
 */
async function syncProposals(): Promise<void> {
  if (sessionId === null) return;
  const sid = sessionId;
  const seq = proposalSync.next();
  let listed: [
    { status: number; body: unknown },
    { status: number; body: unknown },
  ];
  try {
    listed = await Promise.all([
      fetchJson(
        `/api/sessions/${encodeURIComponent(sid)}/conversation-proposals?limit=50&status=pending`,
      ),
      fetchJson(`/api/sessions/${encodeURIComponent(sid)}/trials?limit=50`),
    ]);
  } catch {
    return;
  }
  if (sessionId !== sid || !proposalSync.isCurrent(seq)) return;
  const [conversation, trials] = listed;
  const runIds = knownRunIds();
  const conversationItems =
    conversation.status === 200
      ? proposalListItems(conversation.body).filter(isConversationProposalItem)
      : [];
  const trialItems =
    trials.status === 200
      ? proposalListItems(trials.body).filter(isTrialProposalItem)
      : [];
  const parents = await loadParentSnapshots(sid, conversationItems, runIds);
  if (sessionId !== sid || !proposalSync.isCurrent(seq)) return;
  proposalCards = [
    ...conversationProposalCards(conversationItems, runIds, parents),
    ...trialProposalCards(trialItems),
  ];
}

async function decideConversationProposalCard(
  card: ChatProposalCardView,
  action: "accept" | "reject",
): Promise<void> {
  if (sessionId === null || proposalDeciding !== null) return;
  const sid = sessionId;
  proposalDeciding = card.key;
  proposalNotice = "";
  // Same body the Proposals panel sends: CAS on the staged version. An
  // uncertain retry reuses this exact key + expectedVersion (review #154).
  pendingCardDecision = frozenProposalDecision(
    pendingCardDecision,
    card.key + action,
    { expectedVersion: card.version },
    randomUuid(),
  );
  const result = await postJson(
    `/api/sessions/${encodeURIComponent(sid)}/conversation-proposals/${encodeURIComponent(card.proposalId)}/${action}`,
    pendingCardDecision.body,
    pendingCardDecision.key,
  );
  if (sessionId !== sid) return;
  proposalDeciding = null;
  if (result.status === 0 || result.status >= 500) {
    // Network / 5xx: keep the frozen command and the card for a retry.
    proposalNotice = proposalCardErrorText(0);
    return;
  }
  pendingCardDecision = null;
  proposalNotice =
    result.status === 200 || result.status === 201
      ? action === "accept"
        ? "採用しました"
        : "見送りました"
      : proposalCardErrorText(result.status);
  await syncProposals();
  void syncActions();
}

async function decideTrialProposalCard(
  card: ChatProposalCardView,
  action: "approve" | "expire",
): Promise<void> {
  if (sessionId === null || proposalDeciding !== null) return;
  const sid = sessionId;
  proposalDeciding = card.key;
  proposalNotice = "";
  // Same freeze as conversation decisions: an uncertain approve reply must
  // retry with the exact same Idempotency-Key, not a fresh one (review #154).
  // Expire stays keyless (state-idempotent) and never disturbs a frozen key.
  const decision =
    action === "approve"
      ? frozenProposalDecision(
          pendingCardDecision,
          card.key + action,
          {},
          randomUuid(),
        )
      : null;
  if (decision !== null) pendingCardDecision = decision;
  // postJson/readJson never throw: a transport failure is status 0.
  const result = await postJson(
    `/api/sessions/${encodeURIComponent(sid)}/trials/${encodeURIComponent(card.proposalId)}/${action}`,
    decision?.body ?? {},
    decision?.key ?? null,
  );
  if (sessionId !== sid) return;
  proposalDeciding = null;
  if (decision !== null && (result.status === 0 || result.status >= 500)) {
    // Uncertain outcome: keep the frozen key + card for a retry.
    proposalNotice = proposalCardErrorText(0);
    return;
  }
  if (decision !== null) pendingCardDecision = null;
  const ok =
    action === "approve" ? result.status === 201 : result.status === 200;
  proposalNotice = ok
    ? action === "approve"
      ? "承認しました"
      : "取り消しました"
    : proposalCardErrorText(result.status);
  await syncProposals();
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
  if (posted.status === 0) {
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
  if (posted.status === 0) {
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
  if (posted.status === 0) {
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
    // Re-run the retained session's boot path after the 401 gap: the
    // failed read (history hydration, proposal sync, active-run
    // discovery) must repeat or the missed state stays absent until a
    // full reload (review PR75 4310874696).
    await bootSession();
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
    // PR78 review: a reload adopts this already-active run and drops its
    // draft once; later `answer.draft.delta` frames from the freshly opened
    // stream must never rebuild the bubble (the reload guarantee).
    draft = null;
    draftSuppressedRuns.add(descriptor.runId);
    if (descriptor.status === "cancel_requested") {
      runView = { ...INITIAL_RUN_VIEW, notice: "停止しました" };
      activeRunCursor = 0;
      // PR #82 review (4312961764): a reload-adopted cancelling run shows
      // the stop notice, never the phase line.
      cancelPending = true;
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
  await syncProposals();
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
    stopElapsedTimer();
    for (const timer of watchTimers.values()) window.clearInterval(timer);
    watchTimers.clear();
    for (const timer of pendingExpiryTimers.values())
      window.clearTimeout(timer);
    pendingExpiryTimers.clear();
    document.removeEventListener("visibilitychange", onVisibility);
    onAuthExpired(null);
  };
});

function answerPartsForTurn(turn: Turn, preferVoice = true): AnswerPartView[] {
  if (turn.run === null) return [];
  return runResultToAnswerParts(turn.run.result, { preferVoice }).map((p) => ({
    ...p,
    citations: [...p.citations],
  }));
}

function showsCanonicalAnswer(runId: string): boolean {
  return canonicalAnswers[runId] === true;
}

function toggleAnswerVoice(runId: string): void {
  canonicalAnswers = {
    ...canonicalAnswers,
    [runId]: !showsCanonicalAnswer(runId),
  };
}

function onConversationScroll(): void {
  if (scrollEl === null) return;
  const gap =
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  stickToBottom = gap < 64;
}

// V2 auto-scroll: after any transcript change, stay pinned to the bottom
// unless the user scrolled up. Runs after paint via tick() so the fresh
// content's height is included. E2E DOM contracts are untouched (view-only).
$effect(() => {
  const signature = [
    turns.length,
    liveAnswer.length,
    liveVisible,
    thinking.text.length,
    draft === null ? "" : draftDisplayText(draft),
    runView.notice,
    runView.visible,
    cards.length,
    proposalCards.length,
    proposalNotice,
    showThinking,
    thinkingCollapsed,
    booted,
  ].join("|");
  void signature;
  if (!stickToBottom || scrollEl === null) return;
  void tick().then(() => {
    if (stickToBottom && scrollEl !== null) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
});
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
    <FeatureNav {activePath} />
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

  {#if activePath === "/"}
    {#await import("./lib/AutonomyPausedBanner.svelte") then banner}
      <svelte:component this={banner.default} />
    {/await}
  {/if}

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

  <main
    id="conversation"
    aria-live="polite"
    bind:this={scrollEl}
    onscroll={onConversationScroll}
  >
  <div class="messages">
    {#if !booted && turns.length === 0}
      <p>読み込み中…</p>
    {/if}
    {#if booted && turns.length === 0 && activeRunId === null && cards.length === 0}
      <div id="conversation-empty" role="status">
        <p>質問を入力してください</p>
      </div>
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
          <!-- Task ui-separate-turn-bubbles: the section stays as the outer
               turn wrapper (data-turn-kind contract preserved for e2e), but
               the user prompt and the assistant answer now render as two
               separate rows: the user bubble right-aligned with its own
               background (.msg-user-row), the answer left-aligned below it
               (.msg-assistant-row) like the llama.cpp WebUI transcript. -->
          <div class="msg-user-row">
            <p>{turn.text ?? ""}</p>
          </div>
          {#if turn.run !== null}
            {@const runId = turn.run.runId}
            {@const canonical = showsCanonicalAnswer(runId)}
            {@const parts = answerPartsForTurn(turn, !canonical)}
            {#if parts.length > 0}
              <div class="msg-assistant-row">
                {#if parts.some((part) => part.voicedText !== undefined)}
                  <button
                    type="button"
                    class="voice-toggle"
                    data-voice-toggle="true"
                    data-voice-view={canonical ? "canonical" : "voiced"}
                    aria-label={canonical ? "話し方で表示" : "原文を表示"}
                    onclick={() => toggleAnswerVoice(runId)}
                  >
                    {canonical ? "話し方" : "原文"}
                  </button>
                {/if}
                {#each parts as part, partIndex (partIndex)}
                  <!-- V2: validated answer parts render as sanitized markdown;
                       citation buttons stay adjacent, never inside markdown. -->
                  <Markdown text={part.text} />
                  {#each part.citations as citation (citation)}
                    <button
                      type="button"
                      data-citation={citation}
                      aria-label={citation.startsWith("m")
                        ? `この回答の記憶引用 ${citation}`
                        : `保存された引用 ${chipLabel(citation)}`}
                      onclick={() => void openCitation(citation, runId)}
                    >
                      {chipLabel(citation)}
                    </button>
                  {/each}
                {/each}
              </div>
            {/if}
          {:else if turn.turnId.length > 0}
            <div class="msg-assistant-row">
              <p>応答なし</p>
            </div>
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
    <!-- Task ui-separate-turn-bubbles: the streaming assistant content
         (status line, thinking block, stats, provisional draft, live
         answer) renders as one left-aligned assistant row below the
         user bubble. The sections keep every data-testid/aria contract;
         only the grouping wrapper is new. -->
    <div class="msg-assistant-row">
      {#if activeRunId !== null && runView.visible === "generating" && !cancelPending && !isActionRun(activeRunId)}
        {@const statusText = runStatusText()}
        {#if statusText.length > 0}
          <section data-run-progress="true" aria-label="実行状況">
            <!-- PR #82 review: the elapsed tick lives in an aria-hidden span
                 (excluded from the live region's accessible text) so only the
                 phase transition itself is announced; the visible「秒」count
                 is kept for the e2e DOM contract. -->
            <p id="run-status" data-run-status="true" aria-live="polite"
              >{statusText}<span aria-hidden="true"
                >{formatElapsedSuffix(elapsedSec)}</span
              ></p
            >
          </section>
        {/if}
      {/if}
      {#if showThinking}
        {@const statsLine = formatThinkingStats(thinking.usage)}
        <!-- V3: upstream ChatMessageReasoningBlock look — collapsible header
             with a chevron, muted mono body; auto-collapse behavior unchanged
             (see renderRunView). DOM contracts kept: data-thinking,
             data-thinking-toggle, aria-expanded, data-thinking-text,
             data-run-stats. -->
        <section data-thinking="true" class="thinking-block" aria-label="考え中">
          <button
            type="button"
            class="thinking-toggle"
            data-thinking-toggle="true"
            aria-expanded={!thinkingCollapsed}
            onclick={() => {
              thinkingCollapsed = !thinkingCollapsed;
            }}
          >
            <span class="thinking-chevron" aria-hidden="true"
              >{thinkingCollapsed ? "▸" : "▾"}</span
            >
            <span class="thinking-title"
              >{thinkingCollapsed ? "考え中" : "考え中…"}</span
            >
          </button>
          {#if !thinkingCollapsed}
            <pre
              class="thinking-body"
              data-thinking-text="true">{thinkingDisplayText(thinking)}</pre
            >
          {/if}
          {#if statsLine !== null}
            <p class="run-stats" data-run-stats="true">{statsLine}</p>
          {/if}
        </section>
      {:else}
        {@const statsOnly = formatThinkingStats(thinking.usage)}
        {#if statsOnly !== null}
          <section data-thinking-stats="true" aria-label="実行統計">
            <p data-run-stats="true">{statsOnly}</p>
          </section>
        {/if}
      {/if}
      {#if draft !== null && activeRunId !== null && runView.visible === "generating" && draftDisplayText(draft).length > 0}
        <section data-draft="true" aria-label="下書き" aria-live="off">
          <p data-draft-label="true">{DRAFT_LABEL}</p>
          <p data-draft-text="true">{draftDisplayText(draft)}</p>
        </section>
      {/if}
      {#if liveVisible}
        {@const runId = [...renderedAnswers].pop()}
        {@const canonical = runId !== undefined && showsCanonicalAnswer(runId)}
        <section data-live-answer="true">
          {#if runId !== undefined && liveAnswer.some((part) => part.voicedText !== undefined)}
            <button
              type="button"
              class="voice-toggle"
              data-voice-toggle="true"
              data-voice-view={canonical ? "canonical" : "voiced"}
              aria-label={canonical ? "話し方で表示" : "原文を表示"}
              onclick={() => {
                if (runId !== undefined) toggleAnswerVoice(runId);
              }}
            >
              {canonical ? "話し方" : "原文"}
            </button>
          {/if}
          {#each liveAnswer as part, partIndex (partIndex)}
            <Markdown
              text={canonical ? (part.canonicalText ?? part.text) : part.text}
            />
            {#each part.citations as citation (citation)}
              <button
                type="button"
                data-citation={citation}
                aria-label={citation.startsWith("m")
                  ? `この回答の記憶引用 ${citation}`
                  : `保存された引用 ${chipLabel(citation)}`}
                onclick={() => void openCitation(citation, runId)}
              >
                {chipLabel(citation)}
              </button>
            {/each}
          {/each}
        </section>
      {/if}
    </div>
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
        <button
          id="action-approve"
          type="button"
          data-action-approve="true"
          hidden={!model.decisionVisible}
          disabled={!model.decisionVisible || card.deciding}
          onclick={() => void approve(card)}
        >
          承認
        </button>
        <button
          id="action-reject"
          type="button"
          data-action-reject="true"
          hidden={!model.decisionVisible}
          disabled={!model.decisionVisible || card.deciding}
          onclick={() => void reject(card)}
          >
          却下
        </button>
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
    {#each proposalCards as card (card.key)}
      <section
        data-proposal-card={card.source}
        data-proposal-kind={card.kindLabel}
        data-proposal-status={card.status}
        data-proposal-id={card.proposalId}
        aria-label="提案カード"
      >
        <p data-proposal-label="true">{card.kindLabel}の提案</p>
        {#if card.heading !== ""}
          <p data-proposal-heading="true">{card.heading}</p>
        {/if}
        {#if card.quote !== ""}
          <p data-proposal-quote="true">引用: {card.quote}</p>
        {/if}
        {#if card.parentLine !== ""}
          <p data-proposal-parent="true">{card.parentLine}</p>
        {/if}
        {#each card.detailLines as line, index (index)}
          <p data-proposal-detail="true">{line}</p>
        {/each}
        {#if card.source === "conversation"}
          <button
            type="button"
            data-proposal-action="accept"
            hidden={!card.canAccept}
            disabled={!card.canAccept || proposalDeciding !== null}
            onclick={() => void decideConversationProposalCard(card, "accept")}
          >
            採用する
          </button>
          <button
            type="button"
            data-proposal-action="reject"
            hidden={!card.canReject}
            disabled={!card.canReject || proposalDeciding !== null}
            onclick={() => void decideConversationProposalCard(card, "reject")}
          >
            見送る
          </button>
        {:else}
          <button
            type="button"
            data-proposal-action="approve"
            hidden={!card.canApprove}
            disabled={!card.canApprove || proposalDeciding !== null}
            onclick={() => void decideTrialProposalCard(card, "approve")}
          >
            承認する
          </button>
          <button
            type="button"
            data-proposal-action="expire"
            hidden={!card.canExpire}
            disabled={!card.canExpire || proposalDeciding !== null}
            onclick={() => void decideTrialProposalCard(card, "expire")}
          >
            取り消す
          </button>
        {/if}
      </section>
    {/each}
    {#if proposalNotice !== ""}
      <p role="status" data-proposal-notice="true">{proposalNotice}</p>
    {/if}
  </div>
  </main>

  <!-- Backdrop click-to-close is supplementary; keyboard users close via
       the「閉じる」button inside the dialog. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
  <div
    id="drawer"
    role="dialog"
    aria-label="引用"
    tabindex="-1"
    hidden={!drawerOpen}
    onclick={(e) => {
      if (e.target === e.currentTarget) closeDrawer();
    }}
  >
    <pre id="drawer-body">{drawerBody}</pre>
    {#if drawerWeb !== null}
      <div class="web-citation" data-web-citation="true">
        <p data-web-citation-title="true">{drawerWeb.title}</p>
        <!-- The snapshot body renders once in `#drawer-body` above; this
             block adds only the structured title + external link (no
             second copy of the evidence, PR112 review). -->
        <!-- External launch only: the verified http(s) URL, full text
             visible, no favicon/remote image fetch. -->
        <a
          data-web-citation-url="true"
          href={drawerWeb.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          >{drawerWeb.url}</a
        >
      </div>
    {/if}
    <button type="button" onclick={closeDrawer}>閉じる</button>
  </div>

  <!-- Human-only AGORA review stays bound to the ACTUAL chat session. It is
       loaded lazily only once a session exists, so the base chat entry keeps
       its bundle budget; the panel itself hides on a 404 endpoint. A failed
       chunk load surfaces a plain status message instead of blanking the
       page. -->
  {#if sessionId !== null}
    {#await import("./AgoraPanel.svelte") then module}
      <svelte:component this={module.default} {sessionId} />
    {:catch}
      <p class="agora-load-error" role="status">
        AGORA レビューを読み込めませんでした。再読み込みしてください
      </p>
    {/await}
  {/if}

  <!-- Standing-policy auto-dispatch stays bound to the ACTUAL chat session.
       It is a separate lazy chunk so the base chat entry keeps its bundle
       budget, and it hides itself when the server config returns 404. The
       panel never authorizes a plan or resumes the global control. -->
  {#if sessionId !== null}
    {#await import("./AutodispatchPanel.svelte") then module}
      <svelte:component this={module.default} {sessionId} />
    {:catch}
      <p class="autodispatch-load-error" role="status">
        自動ディスパッチを読み込めませんでした。再読み込みしてください
      </p>
    {/await}
  {/if}

  {#if children}
    <div class="feature-panel-slot">
      {@render children()}
    </div>
  {/if}

  <footer class="composer-bar">
  <div class="composer-column">
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
    <!-- V4: upstream ChatFormInputBasic adaptation — auto-growing textarea
         (max ~10 lines, then scroll), Enter sends / Shift+Enter newline,
         IME-safe (never sends while composing). id/type contracts kept:
         #composer-input stays the send hook; #composer-stop keeps its own
         cancel semantics (card Stop untouched). -->
    <textarea
      id="composer-input"
      rows={1}
      autocomplete="off"
      bind:value={input}
      bind:this={composerEl}
      oninput={() => {
        autogrowTextarea(composerEl);
        if (stickToBottom && scrollEl !== null) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      }}
      oncompositionstart={() => {
        composing = true;
      }}
      oncompositionend={() => {
        composing = false;
        justEndedComposition = true;
        void tick().then(() => {
          justEndedComposition = false;
        });
      }}
      onkeydown={(e) => {
        if (
          shouldSendOnKeydown({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.isComposing,
            keyCode:
              typeof (e as KeyboardEvent).keyCode === "number"
                ? (e as KeyboardEvent).keyCode
                : null,
            composing,
            justEndedComposition,
          })
        ) {
          e.preventDefault();
          void send();
        }
      }}
    ></textarea>
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
  </footer>
</div>

<style>
  @import "./app.css";
</style>
