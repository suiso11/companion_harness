<script lang="ts">
// Native port of the AV04 learning consumer panel (legacy
// `apps/server/src/ui/learning_panel.ts`, markup from `ui/page.ts`).
//
// Same DOM ids / API endpoints / notices as the legacy panel, so the e2e
// specs run unchanged. The pure guards/labels/state types are SHARED with
// the legacy panel via `lib/learning_shared.ts` (one source of truth);
// only the imperative DOM rendering becomes Svelte runes.
//
// Boundaries preserved exactly (pinned by regressions):
// - Hypotheses stay QUIET labels with the explicit「仮説」badge; a
//   `refuted` row is NEVER shown as supported/fact.
// - Evidence is read-only history (text interpolation only, no {@html});
//   source navigation is READ-ONLY scrolling to the owning section — no
//   state change, no new fetch seam.
// - All decisions are explicit HUMAN commits only: support / refute /
//   retire (CAS on the expected version), staged accept/reject, and
//   evidence attach go through the trusted HTTP routes.
// - Uncertain operations freeze {key, expectedVersion, body} IN MEMORY
//   only (same-key retry, never a new key on a lost response). While one
//   operation is unresolved, changing selection or inputs cannot replace
//   it.
// - Session guards invalidate generations SYNC: a held old-session reply
//   can never render into the new session. No user/model body in
//   localStorage. Reads come from the ACTUAL HTTP API.
import { fetchJson, postJson } from "./lib/api.js";
import {
  type EvidenceView,
  type HypothesisView,
  isHypothesisView,
  isRecord,
  KIND_TEXT,
  POLARITY_TEXT,
  readCursor,
  readEvidence,
  readHasMore,
  readItems,
  SOURCE_SECTION,
  SOURCE_TEXT,
  STATUS_TEXT,
  textOf,
  UUID_RE,
} from "./lib/learning_shared.js";

const LS_SESSION = "ch.sessionId";
const SETTLED_EVENT = "ch:run-settled";

function readSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION);
  } catch {
    return null;
  }
}

interface PendingOp {
  readonly hypothesisId: string;
  readonly ownerSession: string;
  readonly endpoint: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

// ---- Reactive state (mirrors the legacy panel's DOM state). ----
let statusText = $state("");
let retryHidden = $state(true);
let historyMoreHidden = $state(true);
let evidenceMoreHidden = $state(true);
/** Newest-first ordered list (same stable sort as the legacy render). */
let rows = $state<HypothesisView[]>([]);
let detailHidden = $state(true);
let detailBadge = $state("");
let detailStatement = $state("");
let detailCounts = $state("");
let evidenceRows = $state<{ label: string; kind: string; sourceId: string }[]>(
  [],
);
// Create form drafts.
let scope = $state("");
let kind = $state("hypothesis");
let statement = $state("");
// Evidence form drafts.
let polarity = $state("supports");
let sourceKind = $state("shadow_job");
let sourceId = $state("");
let note = $state("");

/** Drawer disabled flags computed exactly like the legacy renderDetail. */
let supportDisabled = $state(true);
let refuteDisabled = $state(true);
let retireDisabled = $state(true);
let reaffirmDisabled = $state(true);
let acceptDisabled = $state(true);
let rejectDisabled = $state(true);
let attachDisabled = $state(true);

// ---- Non-reactive state (exact legacy contract). ----
let sessionSeq = 0;
let listSeq = 0;
let listedSession: string | null = null;
let destroyed = false;
let historyCursor: string | null = null;
let historyHasMore = false;
let evidenceCursor: string | null = null;
let evidenceHasMore = false;
let selectedId: string | null = null;
const cache = new Map<string, HypothesisView>();
/** Oldest-first keyset per selection (evidence cache keyed by id). */
const evidenceCache = new Map<string, EvidenceView[]>();
let evidenceLoading = false;
let pendingOp: PendingOp | null = null;
let opInFlight = false;

function setStatus(text: string): void {
  statusText = text;
}

/** Sync invalidation (legacy notifySessionChanged). */
function resetState(): void {
  sessionSeq += 1;
  cache.clear();
  evidenceCache.clear();
  selectedId = null;
  pendingOp = null;
  opInFlight = false;
  historyCursor = null;
  historyHasMore = false;
  evidenceCursor = null;
  evidenceHasMore = false;
  evidenceLoading = false;
  detailHidden = true;
  retryHidden = true;
  evidenceMoreHidden = true;
  historyMoreHidden = true;
  scope = "";
  kind = "hypothesis";
  statement = "";
  statusText = "";
  renderAll();
}

function flagsOf(item: HypothesisView, short: boolean): string {
  return (
    (item.staged ? (short ? "／要承認" : "／要承認（AI提案・未採用）") : "") +
    (item.needsReevaluation
      ? short
        ? "／要再評価"
        : "／要再評価（親の目的が変更されました）"
      : "")
  );
}

function rowLabel(item: HypothesisView): string {
  return (
    `仮説［${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}${flagsOf(item, true)}］` +
    `［${item.scope}］支持${item.evidenceCounts.supports}／反証${item.evidenceCounts.refutes}／中立${item.evidenceCounts.neutral}`
  );
}

/** Newest-first by server timestamp only (stable sort, append order). */
function renderAll(): void {
  historyMoreHidden = !historyHasMore;
  rows = [...cache.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function renderEvidence(id: string): void {
  const stored = evidenceCache.get(id) ?? [];
  if (stored.length === 0) {
    evidenceRows = [{ label: "証拠はまだありません", kind: "", sourceId: "" }];
  } else {
    evidenceRows = stored.map((row) => ({
      label:
        `${textOf(POLARITY_TEXT, row.polarity)}［${textOf(SOURCE_TEXT, row.sourceKind)}］` +
        ` 参照:${row.sourceId.slice(0, 8)}…` +
        (row.note === null ? "" : ` 備考:${row.note}`),
      kind: row.sourceKind,
      sourceId: row.sourceId,
    }));
  }
  evidenceMoreHidden = !evidenceHasMore;
}

/** Render the drawer: statement + explicit label + evidence + controls. */
async function renderDetail(resetInputs: boolean): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  if (item === undefined) return;
  detailBadge = `仮説［${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}${flagsOf(item, false)}］［${item.scope}］`;
  detailStatement = item.statement;
  detailCounts = `証拠: 支持${item.evidenceCounts.supports}／反証${item.evidenceCounts.refutes}／中立${item.evidenceCounts.neutral}（版 ${item.version}）`;
  renderEvidence(item.id);
  // Human-typed evidence inputs survive every same-selection refresh:
  // only an explicit NEW selection clears them.
  if (resetInputs) {
    sourceId = "";
    note = "";
  }
  const locked = opInFlight || pendingOp !== null;
  const terminal = item.status === "retired";
  const staged = item.staged;
  // Explicit transitions need a non-staged, non-terminal record; staged
  // records take accept/reject; retired records take nothing. Reaffirm
  // keeps the status and clears the reevaluation notice, so it needs the
  // notice set (the server rejects a reaffirm without one).
  const decidable = !terminal && !staged && !locked;
  const reaffirmAble =
    !terminal && !staged && !locked && item.needsReevaluation;
  const stagedDecidable = staged && !locked;
  const evidenceAble = !terminal && !staged && !locked;
  supportDisabled = !decidable || item.status !== "open";
  refuteDisabled =
    !decidable || (item.status !== "open" && item.status !== "supported");
  retireDisabled = !decidable;
  reaffirmDisabled = !reaffirmAble;
  acceptDisabled = !stagedDecidable;
  rejectDisabled = !stagedDecidable;
  attachDisabled = !evidenceAble;
}

function select(id: string): void {
  // An unresolved frozen operation pins the drawer: switching selection
  // cannot replace it (the retry affordance stays on the frozen record).
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = cache.get(id);
  if (item === undefined) return;
  selectedId = id;
  detailHidden = false;
  retryHidden = true;
  // A new selection starts evidence paging from the newest page.
  evidenceCursor = null;
  evidenceHasMore = false;
  evidenceLoading = false;
  evidenceCache.set(id, []);
  void renderDetail(true);
  void loadEvidence(item);
}

/** Read one newest-first history page behind the stored keyset cursor. */
async function loadOlderHistory(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null || destroyed) return;
  const cursor = historyCursor;
  if (cursor === null) return;
  const session = sessionSeq;
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(
      `/api/sessions/${sessionId}/learning/hypotheses?limit=50&cursor=${encodeURIComponent(cursor)}`,
    );
  } catch {
    if (session === sessionSeq) {
      setStatus("古い履歴の読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq) return;
  if (res.status !== 200) {
    setStatus("古い履歴の読み込みに失敗しました");
    return;
  }
  // The open drawer (selection, frozen inputs) is preserved: older rows
  // only merge into the list, never reset it.
  for (const item of readItems(res.body)) {
    if (item.sessionId === sessionId) cache.set(item.id, item);
  }
  historyCursor = readCursor(res.body);
  historyHasMore = readHasMore(res.body);
  renderAll();
  if (selectedId !== null) void renderDetail(false);
}

/** Read one oldest-first evidence page behind the selection cursor. */
async function loadMoreEvidence(): Promise<void> {
  const sessionId = readSession();
  const selected = selectedId;
  const cursor = evidenceCursor;
  if (sessionId === null || destroyed || selected === null || cursor === null) {
    return;
  }
  const current = cache.get(selected);
  if (current === undefined) return;
  // Gate concurrent page loads (double-click dedupe); the merge below
  // ALSO dedupes by id, so a late out-of-order reply never duplicates a row.
  if (evidenceLoading) return;
  evidenceLoading = true;
  const session = sessionSeq;
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(
      `/api/sessions/${sessionId}/learning/hypotheses/${selected}/evidence?limit=50&cursor=${encodeURIComponent(cursor)}`,
    );
  } catch {
    evidenceLoading = false;
    if (session === sessionSeq && selectedId === selected) {
      setStatus("古い証拠の読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq || selectedId !== selected) {
    evidenceLoading = false;
    return;
  }
  if (res.status !== 200) {
    setStatus("古い証拠の読み込みに失敗しました");
    evidenceLoading = false;
    return;
  }
  const stored = evidenceCache.get(selected) ?? [];
  const seen = new Set(stored.map((row) => row.id));
  for (const row of readEvidence(res.body)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    stored.push(row);
  }
  evidenceCache.set(selected, stored);
  evidenceCursor = readCursor(res.body);
  evidenceHasMore = readHasMore(res.body);
  evidenceLoading = false;
  const shown = cache.get(selected);
  if (shown !== undefined) renderEvidence(shown.id);
}

async function refresh(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null || destroyed) return;
  // Session change = legacy notifySessionChanged: sync-invalidate every
  // in-flight generation and all cached state BEFORE the boot read, so a
  // previous session's rows/drawer/frozen op can never leak across. The
  // FIRST boot (no listed session yet) must NOT reset: the state is still
  // empty and a reset would erase a just-committed op's status/rows.
  if (listedSession !== null && listedSession !== sessionId) resetState();
  listedSession = sessionId;
  const session = sessionSeq;
  listSeq += 1;
  const seen = listSeq;
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(
      `/api/sessions/${sessionId}/learning/hypotheses?limit=50`,
    );
  } catch {
    if (session === sessionSeq && seen === listSeq) {
      setStatus("学びの読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq || seen !== listSeq) return;
  if (res.status !== 200) {
    setStatus("学びの読み込みに失敗しました");
    return;
  }
  // Merge the newest page into the map (never clear): older pages loaded
  // via「古い履歴を読み込む」stay reachable, and a 409 re-read never drops
  // the older-page row behind the frozen op.
  const freshIds = new Set<string>();
  for (const item of readItems(res.body)) {
    if (item.sessionId === sessionId) {
      cache.set(item.id, item);
      freshIds.add(item.id);
    }
  }
  historyCursor = readCursor(res.body);
  historyHasMore = readHasMore(res.body);
  // A selected hypothesis missing from the newest page is NOT gone: it
  // may live on an older page. Fetch it directly; close the drawer only
  // when the server says it is gone (404). An unresolved frozen op keeps
  // its drawer pinned without any fetch.
  if (pendingOp === null && selectedId !== null && !freshIds.has(selectedId)) {
    const missing = selectedId;
    try {
      const single = await fetchJson(
        `/api/sessions/${sessionId}/learning/hypotheses/${missing}`,
      );
      if (session !== sessionSeq || seen !== listSeq) return;
      if (
        single.status === 200 &&
        isHypothesisView(single.body) &&
        single.body.sessionId === sessionId
      ) {
        cache.set(missing, single.body);
      } else if (single.status === 404) {
        selectedId = null;
        detailHidden = true;
      }
    } catch {
      // Network loss: keep the stale selection (never close on a failed
      // read); the next refresh retries.
    }
  }
  renderAll();
  // Keep the open drawer truthful after a background refresh without
  // clobbering the human's typed inputs: rerender the cached row AND
  // reload the first evidence page.
  if (selectedId !== null) {
    await renderDetail(false);
    const current = selectedId === null ? undefined : cache.get(selectedId);
    if (current !== undefined) void loadEvidence(current);
  }
}

async function loadEvidence(item: HypothesisView): Promise<void> {
  const session = sessionSeq;
  const selected = selectedId;
  try {
    const res = await fetchJson(
      `/api/sessions/${item.sessionId}/learning/hypotheses/${item.id}/evidence?limit=50`,
    );
    if (session !== sessionSeq) return;
    if (selectedId !== selected) return;
    if (res.status !== 200) {
      setStatus("証拠の読み込みに失敗しました");
      return;
    }
    evidenceCache.set(item.id, readEvidence(res.body));
    if (selectedId === item.id) {
      evidenceCursor = readCursor(res.body);
      evidenceHasMore = readHasMore(res.body);
    }
    // Selection-bound: a late reply for a previous selection never
    // overwrites the shown hypothesis's evidence.
    const current = cache.get(item.id);
    if (current === undefined || selectedId !== selected) return;
    renderEvidence(item.id);
  } catch {
    if (session !== sessionSeq) return;
    if (selectedId !== selected) return;
    setStatus("証拠の読み込みに失敗しました");
  }
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  }
}

/** Open the drawer for the created/updated record (owner session only). */
function openDrawer(id: string): void {
  selectedId = id;
  detailHidden = false;
  void renderDetail(true);
  const current = cache.get(id);
  if (current !== undefined) void loadEvidence(current);
}

async function commitCreate(): Promise<void> {
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (sessionId === null || opInFlight) return;
  const scopeValue = scope.trim();
  const statementValue = statement.trim();
  if (scopeValue.length === 0 || statementValue.length === 0) {
    setStatus("範囲と記録を入力してください");
    return;
  }
  if (kind !== "method" && kind !== "hypothesis") {
    setStatus("種別が不正です");
    return;
  }
  // Freeze {key, body} BEFORE the first send: every retry reuses the
  // identical pair, so a redelivered POST replays ONE hypothesis.
  pendingOp = {
    hypothesisId: "",
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/learning/hypotheses`,
    key: newKey(),
    body: { scope: scopeValue, kind, statement: statementValue },
  };
  opInFlight = true;
  await sendPendingOp();
}

async function commitTransition(
  transition: "support" | "refute" | "retire",
): Promise<void> {
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (
    item === undefined ||
    sessionId === null ||
    opInFlight ||
    item.staged ||
    item.status === "retired"
  ) {
    return;
  }
  pendingOp = {
    hypothesisId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/transition`,
    key: newKey(),
    body: { expectedVersion: item.version, transition },
  };
  opInFlight = true;
  await renderDetail(false);
  await sendPendingOp();
}

async function commitDecision(decision: "accept" | "reject"): Promise<void> {
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (item === undefined || sessionId === null || opInFlight || !item.staged) {
    return;
  }
  pendingOp = {
    hypothesisId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/${decision}`,
    key: newKey(),
    body: { expectedVersion: item.version },
  };
  opInFlight = true;
  await renderDetail(false);
  await sendPendingOp();
}

async function commitReaffirm(): Promise<void> {
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (
    item === undefined ||
    sessionId === null ||
    opInFlight ||
    item.staged ||
    item.status === "retired" ||
    !item.needsReevaluation
  ) {
    return;
  }
  pendingOp = {
    hypothesisId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/reaffirm`,
    key: newKey(),
    body: { expectedVersion: item.version },
  };
  opInFlight = true;
  await renderDetail(false);
  await sendPendingOp();
}

async function commitEvidence(): Promise<void> {
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (
    item === undefined ||
    sessionId === null ||
    opInFlight ||
    item.staged ||
    item.status === "retired"
  ) {
    return;
  }
  const sourceIdValue = sourceId.trim();
  const noteValue = note.trim();
  if (sourceIdValue.length === 0) {
    setStatus("参照IDを入力してください");
    return;
  }
  // Client-side UUID validation BEFORE freezing: an ill-shaped source id
  // can never succeed server-side, so it must not pin the panel.
  if (!UUID_RE.test(sourceIdValue)) {
    setStatus("参照IDはUUID形式で入力してください");
    return;
  }
  if (
    polarity !== "supports" &&
    polarity !== "refutes" &&
    polarity !== "neutral"
  ) {
    setStatus("極性が不正です");
    return;
  }
  if (
    sourceKind !== "shadow_job" &&
    sourceKind !== "conversation_proposal" &&
    sourceKind !== "action_receipt" &&
    sourceKind !== "task_event"
  ) {
    setStatus("参照種別が不正です");
    return;
  }
  const body: Record<string, unknown> = {
    polarity,
    sourceKind,
    sourceId: sourceIdValue,
  };
  if (noteValue.length > 0) body.note = noteValue;
  pendingOp = {
    hypothesisId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/evidence`,
    key: newKey(),
    body,
  };
  opInFlight = true;
  await renderDetail(false);
  await sendPendingOp();
}

/** Explicit same-key retry of the frozen pending op (no new key). */
async function retryPendingOp(): Promise<void> {
  if (pendingOp === null || opInFlight) return;
  opInFlight = true;
  if (selectedId !== null) await renderDetail(false);
  await sendPendingOp();
}

async function sendPendingOp(): Promise<void> {
  const op = pendingOp;
  const session = sessionSeq;
  if (op === null) {
    opInFlight = false;
    return;
  }
  let res: { status: number; body: unknown };
  try {
    res = await postJson(op.endpoint, op.body, op.key);
  } catch {
    // postJson normally resolves {status:0} on a lost response; a throw is
    // treated identically (uncertain loss, frozen op survives).
    res = { status: 0, body: null };
  }
  if (res.status === 0) {
    // Uncertain response loss: the frozen op SURVIVES (same-key retry
    // offered, never a new key, never an overwrite).
    if (session !== sessionSeq) return;
    opInFlight = false;
    retryHidden = false;
    setStatus("応答が不確定です。同じ内容で再送してください");
    if (selectedId !== null) await renderDetail(false);
    return;
  }
  if (session !== sessionSeq) return;
  const sessionId = readSession();
  if (sessionId === null || sessionId !== op.ownerSession) return;
  if (res.status === 201 || res.status === 200) {
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus(
      op.hypothesisId === "" ? "仮説を記録しました" : "操作を反映しました",
    );
    // Apply the deterministic returned view BEFORE the refresh (an older-
    // page row falls outside the newest page; only a view owned by THIS
    // session).
    if (isHypothesisView(res.body) && res.body.sessionId === op.ownerSession) {
      cache.set(res.body.id, res.body);
    }
    if (
      op.hypothesisId !== "" &&
      isRecord(res.body) &&
      isHypothesisView(res.body)
    ) {
      cache.set(op.hypothesisId, res.body);
    }
    renderAll();
    await refresh();
    if (session !== sessionSeq) return;
    // Selection-bound: the created/updated record opens only when it is
    // still owned by this session.
    if (op.hypothesisId === "" && isRecord(res.body)) {
      const id = res.body.id;
      if (typeof id === "string" && cache.has(id)) {
        openDrawer(id);
      }
    } else if (selectedId !== null) {
      await renderDetail(false);
      const current = selectedId === null ? undefined : cache.get(selectedId);
      if (current !== undefined) void loadEvidence(current);
    }
    return;
  }
  if (res.status === 409) {
    // Definitive conflict: re-read the truth, then CLEAR the frozen op —
    // retrying the identical frozen body could never succeed.
    opInFlight = false;
    await refresh();
    if (session !== sessionSeq) return;
    if (op.hypothesisId !== "") {
      // The 409 names THIS hypothesis: re-read it DIRECTLY (it may live
      // on an older page) so the drawer evaluates the committed truth.
      try {
        const single = await fetchJson(
          `/api/sessions/${op.ownerSession}/learning/hypotheses/${op.hypothesisId}`,
        );
        if (session !== sessionSeq) return;
        if (
          single.status === 200 &&
          isHypothesisView(single.body) &&
          single.body.sessionId === op.ownerSession
        ) {
          cache.set(op.hypothesisId, single.body);
        }
      } catch {
        // Network loss on the re-read: the refresh above still ran.
      }
    }
    pendingOp = null;
    retryHidden = true;
    if (op.hypothesisId === "") {
      setStatus(
        "競合しました（キーの再利用）。内容を確認して入力し直してください",
      );
      renderAll();
      return;
    }
    const current = cache.get(op.hypothesisId);
    if (current === undefined) {
      setStatus("仮説が見つかりません（別セッションの可能性）");
      if (op.hypothesisId === selectedId) {
        selectedId = null;
        detailHidden = true;
      }
      renderAll();
      return;
    }
    if (current.status === "retired") {
      setStatus("引退しています（履歴を確認してください）");
    } else {
      setStatus(
        "競合しました（版ずれ・キーの再利用）。一覧を確認して入力し直してください",
      );
    }
    renderAll();
    if (selectedId !== null) void renderDetail(false);
    return;
  }
  if (res.status === 400) {
    // Definitive validation rejection: clear the frozen op, keep the
    // selection + typed inputs for correction (never pin the panel).
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus("入力が不正です（内容を確認して入力し直してください）");
    if (selectedId !== null) await renderDetail(false);
    return;
  }
  if (res.status === 404) {
    opInFlight = false;
    await refresh();
    if (session !== sessionSeq) return;
    const isEvidenceOp =
      op.hypothesisId !== "" && op.endpoint.endsWith("/evidence");
    if (isEvidenceOp && cache.has(op.hypothesisId)) {
      // The 404 names the UNKNOWN SOURCE anchor, not the hypothesis:
      // keep the selection + typed inputs, clear the doomed op.
      pendingOp = null;
      retryHidden = true;
      selectedId = op.hypothesisId;
      detailHidden = false;
      setStatus(
        "参照元が見つかりません（試行・候補・記録のIDを確認してください）",
      );
      renderAll();
      await renderDetail(false);
      return;
    }
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus("仮説が見つかりません（別セッションの可能性）");
    selectedId = null;
    detailHidden = true;
    renderAll();
    return;
  }
  opInFlight = false;
  retryHidden = false;
  setStatus("操作に失敗しました。同じ内容で再送できます");
  if (selectedId !== null) await renderDetail(false);
}

/** Read-only navigation to the owning section (scroll only). */
function openSource(source: { kind: string; sourceId: string }): void {
  const target = document.getElementById(
    SOURCE_SECTION[source.kind] ?? "autonomy",
  );
  if (target !== null) {
    try {
      target.scrollIntoView();
    } catch {
      // Best effort: navigation never breaks the drawer.
    }
  }
}

/** One-tap source reuse into the attach form (no UUID memorization). */
function reuseSource(source: { kind: string; sourceId: string }): void {
  sourceKind = source.kind;
  sourceId = source.sourceId;
  setStatus("参照元を転記しました（極性・備考を添えて追加できます）");
}

// Mount: boot the quiet list for the adopted session; unmount: invalidate
// every in-flight generation (legacy destroy/notifySessionChanged).
$effect(() => {
  void refresh();
  // The chat shell boots the session asynchronously: the panel re-binds
  // (sync reset + boot) as soon as the stored session id appears or
  // changes, and refreshes on the run-settled hook (chat window event).
  const watcher = window.setInterval(() => {
    if (destroyed) return;
    if (listedSession !== readSession()) void refresh();
  }, 400);
  const onSettled = (): void => {
    void refresh();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === LS_SESSION) void refresh();
  };
  window.addEventListener(SETTLED_EVENT, onSettled);
  window.addEventListener("storage", onStorage);
  return () => {
    destroyed = true;
    sessionSeq += 1;
    window.clearInterval(watcher);
    window.removeEventListener(SETTLED_EVENT, onSettled);
    window.removeEventListener("storage", onStorage);
  };
});
</script>

<section id="learning" aria-label="学びの記録" class="feature-panel">
  <h2>学びの記録</h2>
  <p>仮説は事実ではありません（支持・反証・引退は明示の操作のみ）</p>
  <form
    id="learning-create-form"
    onsubmit={(event) => {
      event.preventDefault();
      void commitCreate();
    }}
  >
    <input
      id="learning-scope"
      type="text"
      autocomplete="off"
      bind:value={scope}
    />
    <select id="learning-kind" bind:value={kind}>
      <option value="method">方法</option>
      <option value="hypothesis">仮説</option>
    </select>
    <textarea id="learning-statement" bind:value={statement}></textarea>
    <button
      id="learning-create"
      type="button"
      onclick={() => void commitCreate()}
    >
      仮説を記録
    </button>
  </form>
  <ul id="learning-list">
    {#each rows as item (item.id)}
      <li>
        <button type="button" onclick={() => select(item.id)}>
          {rowLabel(item)}
        </button>
      </li>
    {/each}
  </ul>
  <button
    id="learning-refresh"
    type="button"
    onclick={() => void refresh()}
  >
    一覧を更新
  </button>
  <button
    id="learning-more"
    type="button"
    hidden={historyMoreHidden}
    onclick={() => void loadOlderHistory()}
  >
    古い履歴を読み込む
  </button>
  <div id="learning-detail" hidden={detailHidden}>
    <div id="learning-detail-body">
      <p>{detailBadge}</p>
      <p>記録（原文・仮説であり事実ではありません）:</p>
      <p>{detailStatement}</p>
      <p>{detailCounts}</p>
    </div>
    <ul id="learning-evidence-list">
      {#each evidenceRows as row, index (`${index}-${row.sourceId}`)}
        <li>
          <span>{row.label}</span>
          {#if row.kind !== ""}
            <button type="button" onclick={() => openSource(row)}>
              参照元を開く
            </button>
            <button type="button" onclick={() => reuseSource(row)}>
              この参照元を使う
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    <button
      id="learning-evidence-more"
      type="button"
      hidden={evidenceMoreHidden}
      onclick={() => void loadMoreEvidence()}
    >
      古い証拠を読み込む
    </button>
    <select id="learning-evidence-polarity" bind:value={polarity}>
      <option value="supports">支持</option>
      <option value="refutes">反証</option>
      <option value="neutral">中立</option>
    </select>
    <select id="learning-evidence-source-kind" bind:value={sourceKind}>
      <option value="shadow_job">試行</option>
      <option value="conversation_proposal">会話の候補</option>
      <option value="action_receipt">実行記録</option>
      <option value="task_event">作業履歴</option>
    </select>
    <input
      id="learning-evidence-source-id"
      type="text"
      autocomplete="off"
      bind:value={sourceId}
    />
    <input
      id="learning-evidence-note"
      type="text"
      autocomplete="off"
      bind:value={note}
    />
    <button
      id="learning-evidence-attach"
      type="button"
      disabled={attachDisabled}
      onclick={() => void commitEvidence()}
    >
      証拠を結びつける
    </button>
    <button
      id="learning-support"
      type="button"
      disabled={supportDisabled}
      onclick={() => void commitTransition("support")}
    >
      支持する
    </button>
    <button
      id="learning-refute"
      type="button"
      disabled={refuteDisabled}
      onclick={() => void commitTransition("refute")}
    >
      反証する
    </button>
    <button
      id="learning-retire"
      type="button"
      disabled={retireDisabled}
      onclick={() => void commitTransition("retire")}
    >
      引退する
    </button>
    <button
      id="learning-reaffirm"
      type="button"
      disabled={reaffirmDisabled}
      onclick={() => void commitReaffirm()}
    >
      再確認する
    </button>
    <button
      id="learning-accept"
      type="button"
      disabled={acceptDisabled}
      onclick={() => void commitDecision("accept")}
    >
      採用する
    </button>
    <button
      id="learning-reject"
      type="button"
      disabled={rejectDisabled}
      onclick={() => void commitDecision("reject")}
    >
      見送る
    </button>
  </div>
  <button
    id="learning-retry"
    type="button"
    hidden={retryHidden}
    onclick={() => void retryPendingOp()}
  >
    同じ内容で再送
  </button>
  <p id="learning-status" aria-live="polite">{statusText}</p>
</section>
