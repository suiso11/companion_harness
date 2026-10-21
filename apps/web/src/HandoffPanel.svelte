<script lang="ts">
// Native port of the AV03 delegation-handoff consumer panel (legacy
// `apps/server/src/ui/handoff_panel.ts`, markup from `ui/page.ts`).
//
// Same DOM ids / API endpoints / notices as the legacy panel, so the e2e
// specs run unchanged. The pure guards/labels/state types are SHARED with
// the legacy panel via `lib/handoff_shared.ts` (one source of truth); only
// the imperative DOM rendering becomes Svelte runes.
//
// Boundaries preserved exactly (pinned by regressions):
// - Handoffs are HUMAN-DRIVEN records only: every create/dispatch/report/
//   verify/fail/cancel/abnormal-exit/attempt/reaffirm is an explicit human
//   commit (CAS on the expected version). No numeric budget enforcement,
//   no auto-completion.
// - Sandbox claims stay sandbox: a sandbox success NEVER implies
//   production. Boundary flags are recorded claims requiring separate
//   authorization.
// - Frozen criteria are quoted verbatim: verification needs a pass +
//   evidence result for EVERY frozen criterion (all pass).
// - Model text is UNTRUSTED: every string renders via text interpolation
//   only (no {@html}).
// - Uncertain operations freeze {key, expectedVersion, body} IN MEMORY
//   only (same-key retry, never a new key on a lost response). While one
//   operation is unresolved, changing selection or inputs cannot replace
//   it. `postJson` resolving `{status: 0}` counts as uncertain.
// - Session guards: generations invalidate SYNC. No user/model body in
//   localStorage beyond the adopted session id. Reads come from the
//   ACTUAL HTTP API.
import { fetchJson, postJson } from "./lib/api.js";
import {
  BOUNDARY_TEXT,
  CAUSE_TEXT,
  type HandoffView,
  isHandoffView,
  isRecord,
  OP_SCOPE_TEXT,
  readActiveCount,
  readCursor,
  readHasMore,
  readItems,
  STATUS_TEXT,
  textOf,
  UUID_RE,
} from "./lib/handoff_shared.js";

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
  readonly handoffId: string;
  readonly ownerSession: string;
  readonly endpoint: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

interface OptionRow {
  readonly value: string;
  readonly label: string;
}

// ---- Reactive state (mirrors the legacy panel's DOM state). ----
// Create form drafts.
let task = $state("");
let target = $state("");
let criteria = $state("");
let opScope = $state("investigate");
let budget = $state("");
const boundariesAll: readonly string[] = [
  "external_publication",
  "shared_branch",
  "payment",
  "deletion",
  "secret",
  "access_change",
];
let boundaries = $state<string[]>([]);
let supersedes = $state("");
let statusText = $state("");
let retryHidden = $state(true);
let moreHidden = $state(true);
let activeCount = $state("実行中の記録数: 不明");
let rows = $state<HandoffView[]>([]);
let detailHidden = $state(true);
let detailItem = $state<HandoffView | null>(null);
let eventsLines = $state<readonly string[]>([]);
let attemptsLines = $state<readonly string[]>([]);
let externalRef = $state("");
let reportEnv = $state("sandbox");
let reportSummary = $state("");
let specText = $state<string | null>(null);
// Per-criterion verify inputs for the OPEN selection (preserved across
// same-selection refreshes; only an explicit NEW selection clears them).
let verifyPass = $state<string[]>([]);
let verifyEvidence = $state<string[]>([]);
// Create-form datalist options (tasks + handoff predecessors).
let taskOptions = $state<OptionRow[]>([]);
let supersedesOptions = $state<OptionRow[]>([]);

// ---- Non-reactive state (exact legacy contract). ----
let sessionSeq = 0;
let listSeq = 0;
let destroyed = false;
let listedSession: string | null = null;
let historyCursor: string | null = null;
let historyHasMore = false;
let selectedId: string | null = null;
/** Newest-first keyset cache (older pages stay reachable). */
const cache = new Map<string, HandoffView>();
let pendingOp = $state<PendingOp | null>(null);
let opInFlight = $state(false);

function setStatus(text: string): void {
  statusText = text;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  }
}

function flagsOf(item: HandoffView): string {
  return item.needsReevaluation ? "／要再評価" : "";
}

function boundsOf(item: HandoffView): string {
  return item.boundaries.length === 0
    ? ""
    : `［要承認:${item.boundaries.map((b) => textOf(BOUNDARY_TEXT, b)).join("・")}］`;
}

function rowLabel(item: HandoffView): string {
  // Explicit handoff badge: status + scope + reevaluation flag. Raw
  // UUIDs hidden, status human-readable.
  return (
    `引継ぎ［${textOf(STATUS_TEXT, item.status)}・${textOf(OP_SCOPE_TEXT, item.opScope)}${flagsOf(item)}］` +
    `［試行${item.activeAttempt}］${boundsOf(item)}`
  );
}

function rowTitle(item: HandoffView): string {
  // Discoverable IDs: the full handoff/task UUIDs are exposed here
  // (hover) and in the detail drawer (selectable text), so the create
  // form can be filled without API/devtools round-trips. The badge
  // text itself stays human-readable.
  return `引継ぎID: ${item.id}\n作業ID: ${item.taskId}`;
}

/** Old-criteria diff suffix (empty when the superseded row is unknown). */
function supersedeDiff(item: HandoffView): string {
  const oldCriteria =
    item.supersedesHandoffId !== null
      ? cache.get(item.supersedesHandoffId)?.acceptanceCriteria
      : undefined;
  if (oldCriteria === undefined) return "";
  const added = item.acceptanceCriteria.filter((c) => !oldCriteria.includes(c));
  const removed = oldCriteria.filter(
    (c) => !item.acceptanceCriteria.includes(c),
  );
  return `（旧条件との差分: 追加${added.length}・削除${removed.length}。旧記録は凍結のまま残ります）`;
}

/** Drawer disabled flags computed exactly like the legacy renderDetail. */
const flags = $derived.by(() => {
  const item = detailItem;
  if (item === null) return null;
  const locked = opInFlight || pendingOp !== null;
  const terminal =
    item.status === "verified" ||
    item.status === "failed" ||
    item.status === "cancelled";
  const active = !terminal && !locked;
  return {
    dispatchable:
      active && item.status === "prepared" && !item.needsReevaluation,
    reportable: active && item.status === "dispatched",
    verifiable: active && item.status === "reported",
    retryable:
      !locked &&
      (item.status === "prepared" ||
        item.status === "dispatched" ||
        item.status === "reported" ||
        item.status === "failed") &&
      !item.needsReevaluation &&
      item.supersededBy === null,
    // Cancel is ALWAYS allowed (even under a reevaluation notice).
    cancellable:
      !locked &&
      (item.status === "prepared" ||
        item.status === "dispatched" ||
        item.status === "reported"),
    reaffirmAble:
      !locked &&
      item.needsReevaluation &&
      (item.status === "prepared" ||
        item.status === "dispatched" ||
        item.status === "reported" ||
        item.status === "failed"),
    active,
  };
});

function newOrder(): HandoffView[] {
  return [...cache.values()].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
  );
}

function renderAll(): void {
  moreHidden = !historyHasMore;
  rows = newOrder();
}

/** Render the drawer state: frozen fields + verify rows + controls. */
function renderDetail(resetInputs: boolean): void {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  if (item === undefined) return;
  detailItem = item;
  // Per-criterion verify rows (frozen list length); human pass+evidence
  // inputs survive every same-selection refresh.
  const keptPass = resetInputs ? [] : verifyPass;
  const keptEvidence = resetInputs ? [] : verifyEvidence;
  verifyPass = item.acceptanceCriteria.map((_, index) => keptPass[index] ?? "");
  verifyEvidence = item.acceptanceCriteria.map(
    (_, index) => keptEvidence[index] ?? "",
  );
  // Human-typed report/external inputs survive every same-selection
  // refresh: only an explicit NEW selection clears them.
  if (resetInputs) {
    externalRef = "";
    reportSummary = "";
    specText = null;
  }
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
      `/api/sessions/${sessionId}/handoffs?limit=50&cursor=${encodeURIComponent(cursor)}`,
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
  if (selectedId !== null) renderDetail(false);
}

async function refresh(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null || destroyed) return;
  // Session change = legacy notifySessionChanged: sync-invalidate every
  // in-flight generation and all cached state BEFORE the boot read, so a
  // previous session's rows/drawer/frozen op can never leak across. The
  // FIRST boot (no listed session yet) must NOT reset: the state is still
  // empty and a reset would erase a just-committed op's status/rows.
  if (listedSession !== null && listedSession !== sessionId) {
    sessionSeq += 1;
    cache.clear();
    selectedId = null;
    pendingOp = null;
    opInFlight = false;
    historyCursor = null;
    historyHasMore = false;
    detailHidden = true;
    detailItem = null;
    retryHidden = true;
    eventsLines = [];
    attemptsLines = [];
    // Sync-clear the create-form datalists too: the previous session's
    // task/predecessor IDs must not survive the switch (finding: stale
    // handoff task choices when no tasks remain).
    taskOptions = [];
    supersedesOptions = [];
    renderAll();
  }
  listedSession = sessionId;
  const session = sessionSeq;
  listSeq += 1;
  const seen = listSeq;
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(`/api/sessions/${sessionId}/handoffs?limit=50`);
  } catch {
    if (session === sessionSeq && seen === listSeq) {
      setStatus("引継ぎの読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq || seen !== listSeq) return;
  // Session binding recheck: the response applies only if the same session
  // id still holds (mirrors the request-token pattern used by the panel's
  // other guards); a mid-flight session change discards this page.
  if (readSession() !== sessionId) return;
  if (res.status !== 200) {
    setStatus("引継ぎの読み込みに失敗しました");
    return;
  }
  // Merge the newest page into the map (never clear): older pages loaded
  // via「古い履歴を読み込む」stay reachable, and a 409 re-read never
  // drops the older-page row behind the frozen op.
  const newest = readItems(res.body).filter(
    (item) => item.sessionId === sessionId,
  );
  for (const item of newest) cache.set(item.id, item);
  historyCursor = readCursor(res.body);
  historyHasMore = readHasMore(res.body);
  const active = readActiveCount(res.body);
  // Concurrency TRACKING count only: no numeric limit is invented or
  // enforced (active = dispatched/reported).
  activeCount =
    active === null
      ? "実行中の記録数: 不明"
      : `実行中の記録数: ${active}（上限なし・追跡のみ）`;
  // The newest page, not the map, decides: a selected handoff that
  // lives only on an OLDER page stays in the map but may be stale or
  // superseded — re-fetch it directly anyway. An unresolved frozen op
  // keeps its drawer pinned without any fetch.
  if (pendingOp === null && selectedId !== null) {
    if (!newest.some((item) => item.id === selectedId)) {
      const missing = selectedId;
      try {
        const single = await fetchJson(
          `/api/sessions/${sessionId}/handoffs/${missing}`,
        );
        if (session !== sessionSeq || seen !== listSeq) return;
        if (
          single.status === 200 &&
          isHandoffView(single.body) &&
          single.body.sessionId === sessionId
        ) {
          cache.set(missing, single.body);
        } else if (single.status === 404) {
          selectedId = null;
          detailHidden = true;
          detailItem = null;
        }
      } catch {
        // Network loss: keep the stale selection (never close on a
        // failed read); the next refresh retries.
      }
    }
  }
  renderAll();
  // Keep the open drawer truthful after a background refresh without
  // clobbering the human's typed inputs.
  if (selectedId !== null) renderDetail(false);
  // Selectable create-form IDs: fill the task/predecessor datalists so
  // the UUID fields can be chosen from the shipped UI (no devtools).
  // Best-effort: a failed read leaves the manual UUID entry usable.
  fillCreateLists(sessionId, session, seen);
}

/** Populate the create-form datalists (tasks + handoff predecessors). */
function fillCreateLists(
  sessionId: string,
  session: number,
  seen: number,
): void {
  supersedesOptions = [...cache.values()]
    .filter((item) => item.sessionId === sessionId)
    .map((item) => ({
      value: item.id,
      label: `引継ぎ ${item.id.slice(0, 8)}…（${item.status}）`,
    }));
  void fillTaskTitles(sessionId, session, seen);
}

/** Enrich task options with human titles (best-effort, never blocking). */
async function fillTaskTitles(
  sessionId: string,
  session: number,
  seen: number,
): Promise<void> {
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(`/api/sessions/${sessionId}/tasks?limit=50`);
  } catch {
    return;
  }
  if (session !== sessionSeq || seen !== listSeq) return;
  if (readSession() !== sessionId) return;
  if (res.status !== 200 || !isRecord(res.body)) return;
  const items = Array.isArray(res.body.items)
    ? (res.body.items as unknown[])
    : [];
  // A successful EMPTY response clears the options: after switching from a
  // session with tasks to one with none, the datalist must not keep offering
  // the previous session's task IDs (a cross-session submit would fail).
  const options: OptionRow[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string") continue;
    const title = typeof entry.title === "string" ? entry.title : "";
    const status = typeof entry.status === "string" ? entry.status : "";
    options.push({
      value: entry.id,
      label: title.length > 0 ? `${title.slice(0, 40)}（${status}）` : status,
    });
  }
  taskOptions = options;
}

function select(id: string): void {
  // An unresolved frozen operation pins the drawer: switching selection
  // cannot replace it (the retry affordance stays on the frozen record,
  // and the frozen key/body/action is never overwritten).
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = cache.get(id);
  if (item === undefined) return;
  selectedId = id;
  detailHidden = false;
  retryHidden = true;
  renderDetail(true);
  void loadHistory(item);
}

/** Reset BOTH history lists IMMEDIATELY: a switch to a new selection
 * never leaves the previous selection's history rows lingering. */
async function loadHistory(item: HandoffView): Promise<void> {
  const session = sessionSeq;
  const selected = selectedId;
  eventsLines = [];
  attemptsLines = [];
  try {
    const [events, attempts] = await Promise.all([
      fetchJson(`/api/sessions/${item.sessionId}/handoffs/${item.id}/events`),
      fetchJson(`/api/sessions/${item.sessionId}/handoffs/${item.id}/attempts`),
    ]);
    if (session !== sessionSeq) return;
    if (selectedId !== selected) return;
    // Non-200 (404/409/fallback) is a FAILURE, never silent emptiness:
    // an empty list after a failed read would lie that nothing exists.
    if (events.status !== 200 || attempts.status !== 200) {
      eventsLines = ["履歴の読み込みに失敗しました"];
      setStatus("履歴の読み込みに失敗しました");
      return;
    }
    const eventRows =
      isRecord(events.body) && Array.isArray(events.body.events)
        ? (events.body.events as unknown[])
        : [];
    if (eventRows.length === 0) {
      eventsLines = ["履歴はまだありません"];
    } else {
      const lines: string[] = [];
      for (const row of eventRows) {
        if (!isRecord(row)) continue;
        lines.push(
          `${String(row.event)}: ${String(row.fromStatus ?? "-")} → ${String(row.toStatus)}${row.note === null || row.note === undefined ? "" : ` ／ ${String(row.note).slice(0, 80)}`}`,
        );
      }
      eventsLines = lines;
    }
    const attemptRows =
      isRecord(attempts.body) && Array.isArray(attempts.body.attempts)
        ? (attempts.body.attempts as unknown[])
        : [];
    if (attemptRows.length === 0) {
      attemptsLines = ["試行記録はまだありません（自動再試行なし）"];
    } else {
      const lines: string[] = [];
      for (const row of attemptRows) {
        if (!isRecord(row)) continue;
        lines.push(
          `試行${String(row.attemptNo)}: ${textOf(CAUSE_TEXT, String(row.cause))}（人手で記録・自動再試行なし）`,
        );
      }
      attemptsLines = lines;
    }
  } catch {
    if (session !== sessionSeq) return;
    if (selectedId !== selected) return;
    setStatus("履歴の読み込みに失敗しました");
  }
}

async function commitCreate(): Promise<void> {
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (sessionId === null || opInFlight) return;
  const taskId = task.trim();
  const targetValue = target.trim();
  const criteriaList = criteria
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const budgetValue = budget.trim();
  const supersedesValue = supersedes.trim();
  if (!UUID_RE.test(taskId)) {
    setStatus("作業IDはUUID形式で入力してください");
    return;
  }
  if (targetValue.length === 0 || criteriaList.length === 0) {
    setStatus("目的と受入条件を入力してください");
    return;
  }
  if (opScope !== "investigate" && opScope !== "implement") {
    setStatus("作業範囲が不正です");
    return;
  }
  if (supersedesValue.length > 0 && !UUID_RE.test(supersedesValue)) {
    setStatus("継承元IDはUUID形式で入力してください");
    return;
  }
  const body: Record<string, unknown> = {
    taskId,
    target: targetValue,
    acceptanceCriteria: criteriaList,
    opScope,
    boundaries: [...boundaries],
  };
  if (budgetValue.length > 0) body.budgetLabel = budgetValue;
  if (supersedesValue.length > 0) body.supersedesHandoffId = supersedesValue;
  // Freeze {key, body} BEFORE the first send: every retry reuses the
  // identical pair, so a redelivered POST replays ONE handoff.
  pendingOp = {
    handoffId: "",
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/handoffs`,
    key: newKey(),
    body,
  };
  opInFlight = true;
  await sendPendingOp();
}

/** Dispatch / fail / cancel / abnormal-exit / reaffirm (CAS version only). */
async function commitMutation(
  suffix: "dispatch" | "fail" | "cancel" | "abnormal-exit" | "reaffirm",
): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (item === undefined || sessionId === null || opInFlight) return;
  if (suffix === "dispatch" && item.needsReevaluation) {
    setStatus("要再評価のため送付できません。再確認してください");
    return;
  }
  const body: Record<string, unknown> = {
    expectedVersion: item.version,
  };
  // Dispatch records an optional human external reference text (never
  // resolved, never fetched).
  if (suffix === "dispatch" && externalRef.trim().length > 0) {
    body.externalRef = externalRef.trim();
  }
  pendingOp = {
    handoffId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/${suffix}`,
    key: newKey(),
    body,
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

/** Record the UNTRUSTED worker report (sandbox NEVER means production). */
async function commitReport(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (item === undefined || sessionId === null || opInFlight) return;
  const environment = reportEnv;
  const summary = reportSummary.trim();
  if (environment !== "sandbox" && environment !== "production") {
    setStatus("報告環境が不正です");
    return;
  }
  if (summary.length === 0) {
    setStatus("報告内容を入力してください（未検証の申告として記録）");
    return;
  }
  pendingOp = {
    handoffId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/report`,
    key: newKey(),
    body: { expectedVersion: item.version, environment, summary },
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

/** Verification: pass + evidence for EVERY frozen criterion (all pass). */
async function commitVerify(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (item === undefined || sessionId === null || opInFlight) return;
  if (verifyPass.length !== item.acceptanceCriteria.length) {
    setStatus("検証入力を読み込めません（一覧を更新してください）");
    return;
  }
  const results: { index: number; pass: boolean; evidence: string }[] = [];
  for (let index = 0; index < verifyPass.length; index += 1) {
    const verdict = verifyPass[index] ?? "";
    const evidence = (verifyEvidence[index] ?? "").trim();
    if (verdict !== "pass" && verdict !== "fail") {
      setStatus(`条件${index + 1}の合否を選択してください`);
      return;
    }
    if (evidence.length === 0) {
      setStatus(`条件${index + 1}の証拠を入力してください`);
      return;
    }
    results.push({
      index,
      pass: verdict === "pass",
      evidence,
    });
  }
  pendingOp = {
    handoffId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/verify`,
    key: newKey(),
    body: { expectedVersion: item.version, results },
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

/** Explicit human retry record with a REQUIRED cause (never automatic). */
async function commitAttempt(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (item === undefined || sessionId === null || opInFlight) return;
  const cause = attemptCause;
  if (
    cause !== "transient_infra" &&
    cause !== "worker_error" &&
    cause !== "criteria_unmet" &&
    cause !== "environment"
  ) {
    setStatus("再試行の原因を選択してください");
    return;
  }
  pendingOp = {
    handoffId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/attempt`,
    key: newKey(),
    body: { expectedVersion: item.version, cause },
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

let attemptCause = $state("transient_infra");

/** Fetch the deterministic handoff spec and copy it for manual pi-orch. */
async function exportSpec(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  if (item === undefined || sessionId === null) return;
  const session = sessionSeq;
  const selected = selectedId;
  let res: { status: number; text: string };
  try {
    const response = await fetch(
      `/api/sessions/${sessionId}/handoffs/${item.id}/spec`,
      { credentials: "same-origin", headers: { accept: "text/plain" } },
    );
    res = { status: response.status, text: await response.text() };
  } catch {
    if (session === sessionSeq) {
      setStatus("仕様の取得に失敗しました");
    }
    return;
  }
  if (session !== sessionSeq || selectedId !== selected) return;
  if (res.status !== 200) {
    setStatus("仕様の取得に失敗しました");
    return;
  }
  specText = res.text;
  setStatus("仕様を取得しました（実行は自動化されません）");
}

function copySpec(): void {
  const text = specText;
  if (text === null) return;
  try {
    const done = navigator.clipboard?.writeText(text);
    if (done !== undefined) {
      void done.then(
        () => setStatus("仕様をコピーしました"),
        () => setStatus("コピーに失敗しました（選択して手動コピー）"),
      );
    } else {
      setStatus("選択して手動でコピーしてください");
    }
  } catch {
    setStatus("選択して手動でコピーしてください");
  }
}

/** Explicit same-key retry of the frozen pending op (no new key). */
async function retryPendingOp(): Promise<void> {
  if (pendingOp === null || opInFlight) return;
  opInFlight = true;
  if (selectedId !== null) renderDetail(false);
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
    // postJson normally resolves {status:0} on a lost response; a throw
    // is treated identically (uncertain loss, frozen op survives).
    res = { status: 0, body: null };
  }
  if (res.status === 0) {
    // Uncertain response loss: the frozen op SURVIVES (same-key retry
    // offered, never a new key, never an overwrite).
    if (session !== sessionSeq) return;
    opInFlight = false;
    retryHidden = false;
    setStatus("応答が不確定です。同じ内容で再送してください");
    if (selectedId !== null) renderDetail(false);
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
      op.handoffId === "" ? "引継ぎを記録しました" : "操作を反映しました",
    );
    // Apply the deterministic returned view BEFORE the refresh: the
    // map (and the open drawer) shows the committed truth even while
    // the page fetch is in flight. Only a view owned by THIS session.
    if (isHandoffView(res.body) && res.body.sessionId === op.ownerSession) {
      cache.set(res.body.id, res.body);
    }
    await refresh();
    if (session !== sessionSeq) return;
    // Selection-bound: the created/updated record opens only when it is
    // still owned by this session.
    if (op.handoffId === "" && isRecord(res.body)) {
      const id = res.body.id;
      if (typeof id === "string" && cache.has(id)) {
        selectedId = id;
        detailHidden = false;
        renderDetail(true);
        const current = cache.get(id);
        if (current !== undefined) void loadHistory(current);
      }
    } else if (selectedId !== null) {
      renderDetail(false);
      const current = selectedId === null ? undefined : cache.get(selectedId);
      if (current !== undefined) void loadHistory(current);
    }
    return;
  }
  if (res.status === 409) {
    // Definitive conflict (version mismatch, lifecycle conflict, or key
    // reuse): re-read the truth, then CLEAR the frozen op — retrying the
    // identical frozen body could never succeed, so keeping it would pin
    // the panel forever. The human re-commits fresh (new key, new
    // version) after reading the honest message. Only network loss and
    // 5xx/503 keep the frozen op (handled above/below).
    opInFlight = false;
    await refresh();
    if (session !== sessionSeq) return;
    if (op.handoffId !== "") {
      // The 409 names THIS handoff: re-read it DIRECTLY (not just via
      // the newest page — it may live on an older page or have been
      // superseded) so the drawer evaluates against the committed truth.
      try {
        const single = await fetchJson(
          `/api/sessions/${op.ownerSession}/handoffs/${op.handoffId}`,
        );
        if (session !== sessionSeq) return;
        if (
          single.status === 200 &&
          isHandoffView(single.body) &&
          single.body.sessionId === op.ownerSession
        ) {
          cache.set(op.handoffId, single.body);
        }
      } catch {
        // Network loss on the re-read: the refresh above still ran; the
        // drawer keeps whatever truth it has.
      }
    }
    pendingOp = null;
    retryHidden = true;
    if (op.handoffId === "") {
      setStatus(
        "競合しました（キーの再利用）。内容を確認して入力し直してください",
      );
      return;
    }
    const current = cache.get(op.handoffId);
    if (current === undefined) {
      setStatus("引継ぎが見つかりません（別セッションの可能性）");
      if (op.handoffId === selectedId) {
        selectedId = null;
        detailHidden = true;
        detailItem = null;
      }
      renderAll();
      return;
    }
    if (current.status === "verified") {
      setStatus("検証済みです（条件の変更は新規引継ぎで継承）");
    } else if (current.needsReevaluation) {
      setStatus("要再評価のため実行できません。再確認して入力し直してください");
    } else {
      setStatus(
        "競合しました（版ずれ・キーの再利用）。一覧を確認して入力し直してください",
      );
    }
    renderAll();
    if (selectedId !== null) renderDetail(false);
    return;
  }
  if (res.status === 400) {
    // Definitive validation rejection: the identical body can never
    // succeed, so clear the frozen op and keep the selection + typed
    // inputs for correction (never pin the panel).
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus("入力が不正です（内容を確認して入力し直してください）");
    if (selectedId !== null) renderDetail(false);
    return;
  }
  if (res.status === 404) {
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    if (op.handoffId === "") {
      // CREATE against a vanished task/inherit-source: the drawer (and
      // every typed input) stays open — only the JSON body was wrong,
      // so the human can correct one field and re-commit fresh.
      setStatus("作業または継承元が見つかりません");
      return;
    }
    setStatus("引継ぎが見つかりません（別セッションの可能性）");
    // Close the drawer ONLY when the 404 names the open selection: a
    // 404 for a background/older record must not clear the human's
    // current drawer.
    if (op.handoffId === selectedId) {
      selectedId = null;
      detailHidden = true;
      detailItem = null;
    }
    renderAll();
    if (selectedId !== null) renderDetail(false);
    return;
  }
  opInFlight = false;
  retryHidden = false;
  setStatus("操作に失敗しました。同じ内容で再送できます");
  if (selectedId !== null) renderDetail(false);
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
    const sessionId = readSession();
    if (listedSession !== sessionId) {
      listedSession = sessionId;
      // Session lifecycle: clear state, hide drawer, boot new session.
      sessionSeq += 1;
      cache.clear();
      selectedId = null;
      pendingOp = null;
      opInFlight = false;
      historyCursor = null;
      historyHasMore = false;
      detailHidden = true;
      detailItem = null;
      retryHidden = true;
      eventsLines = [];
      attemptsLines = [];
      taskOptions = [];
      supersedesOptions = [];
      renderAll();
      void refresh();
    }
  }, 400);
  const onSettled = (): void => {
    // Run-settled hook: re-read the quiet list (never taskize chat).
    void refresh();
  };
  window.addEventListener(SETTLED_EVENT, onSettled);
  return () => {
    destroyed = true;
    sessionSeq += 1;
    window.clearInterval(watcher);
    window.removeEventListener(SETTLED_EVENT, onSettled);
  };
});
</script>

<section id="handoff" aria-label="引継ぎ" class="feature-panel">
  <h2>引継ぎ（pi-orchへの手動受渡）</h2>
  <p>
    実行は自動化されません。人が仕様を貼り付けてpi-orchへ渡し、検証済み結果を記録します（サンドボックス成功≠本番／権限は別途承認）
  </p>
  <form id="handoff-create-form" onsubmit={(event) => event.preventDefault()}>
    <input
      id="handoff-task"
      type="text"
      autocomplete="off"
      list="handoff-task-list"
      bind:value={task}
    />
    <datalist id="handoff-task-list">
      {#each taskOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </datalist>
    <textarea id="handoff-target" bind:value={target}></textarea>
    <textarea id="handoff-criteria" bind:value={criteria}></textarea>
    <select id="handoff-op-scope" bind:value={opScope}>
      <option value="investigate">調査</option>
      <option value="implement">実装</option>
    </select>
    <input id="handoff-budget" type="text" autocomplete="off" bind:value={budget} />
    <select id="handoff-boundaries" multiple bind:value={boundaries}>
      {#each boundariesAll as boundary (boundary)}
        <option value={boundary}>{textOf(BOUNDARY_TEXT, boundary)}</option>
      {/each}
    </select>
    <input
      id="handoff-supersedes"
      type="text"
      autocomplete="off"
      list="handoff-supersedes-list"
      bind:value={supersedes}
    />
    <datalist id="handoff-supersedes-list">
      {#each supersedesOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </datalist>
    <button
      id="handoff-create"
      type="button"
      onclick={() => void commitCreate()}
    >
      引継ぎを記録
    </button>
  </form>
  <p id="handoff-active-count" aria-live="polite">{activeCount}</p>
  <ul id="handoff-list">
    {#each rows as item (item.id)}
      <li>
        <button
          type="button"
          onclick={() => select(item.id)}
          title={rowTitle(item)}
        >
          {rowLabel(item)}
        </button>
      </li>
    {/each}
  </ul>
  <button
    id="handoff-refresh"
    type="button"
    onclick={() => void refresh()}
  >
    一覧を更新
  </button>
  <button
    id="handoff-more"
    type="button"
    hidden={moreHidden}
    onclick={() => void loadOlderHistory()}
  >
    古い履歴を読み込む
  </button>
  <div id="handoff-detail" hidden={detailHidden}>
    <div id="handoff-detail-body">
      {#if detailItem !== null}
        {#if detailItem.supersedesHandoffId !== null || detailItem.supersededBy !== null}
          <p>
            継承:
            {detailItem.supersedesHandoffId === null
              ? ""
              : `旧=${detailItem.supersedesHandoffId.slice(0, 8)}…`}
            {detailItem.supersededBy === null
              ? ""
              : `新=${detailItem.supersededBy.slice(0, 8)}…`}{supersedeDiff(detailItem)}
          </p>
        {/if}
        <p>
          引継ぎ［{textOf(STATUS_TEXT, detailItem.status)}・{textOf(OP_SCOPE_TEXT, detailItem.opScope)}{detailItem.needsReevaluation
            ? "／要再評価（親の目的が変更されました。送付前に再確認してください）"
            : ""}］（版 {detailItem.version}・試行 {detailItem.activeAttempt}）
        </p>
        <p>引継ぎID: {detailItem.id} ／ 作業ID: {detailItem.taskId}</p>
        <p>目的（凍結・人間入力）:</p>
        <p>{detailItem.target}</p>
        <p>
          受入条件（凍結 {detailItem.acceptanceCriteria.length}
          件・変更は新規引継ぎで継承のみ）:
        </p>
        <ol>
          {#each detailItem.acceptanceCriteria as criterion (criterion)}
            <li>{criterion}</li>
          {/each}
        </ol>
        <p>
          予算（人間入力の文字列・数値強制なし）:
          {detailItem.budgetLabel ?? "（申告なし）"}
        </p>
        <p>
          {detailItem.boundaries.length === 0
            ? "権限: 追加の個別承認を要する申請なし"
            : `権限は別途承認: ${detailItem.boundaries.map((b) => textOf(BOUNDARY_TEXT, b)).join("・")} は個別承認が必要（この記録は何も許可しません）`}
        </p>
        <p>
          {detailItem.reportEnvironment === null
            ? "報告: まだありません（サンドボックス成功≠本番）"
            : `報告（未検証の作業者申告）: 環境=${detailItem.reportEnvironment}／${detailItem.reportSummary ?? ""}（サンドボックス成功≠本番）`}
        </p>
      {/if}
    </div>
    <ul id="handoff-events-list">
      {#each eventsLines as line}
        <li>{line}</li>
      {/each}
    </ul>
    <ul id="handoff-attempts-list">
      {#each attemptsLines as line}
        <li>{line}</li>
      {/each}
    </ul>
    <input
      id="handoff-external-ref"
      type="text"
      autocomplete="off"
      bind:value={externalRef}
    />
    <button
      id="handoff-dispatch"
      type="button"
      disabled={!flags?.dispatchable}
      onclick={() => void commitMutation("dispatch")}
    >
      送付する
    </button>
    <select id="handoff-report-env" bind:value={reportEnv}>
      <option value="sandbox">砂箱</option>
      <option value="production">本番（未検証申告）</option>
    </select>
    <textarea id="handoff-report-summary" bind:value={reportSummary}></textarea>
    <button
      id="handoff-report"
      type="button"
      disabled={!flags?.reportable}
      onclick={() => void commitReport()}
    >
      報告する
    </button>
    <div id="handoff-verify-rows">
      <p>
        検証（全条件が合格かつ証拠必須・一つでも不合格なら検証不可・条件を緩めない）:
      </p>
      {#each detailItem?.acceptanceCriteria ?? [] as criterion, index}
        <div>
          <p>条件{index + 1}: {criterion}</p>
          <select bind:value={verifyPass[index]}>
            <option value="">未判定</option>
            <option value="pass">合格</option>
            <option value="fail">不合格</option>
          </select>
          <input
            type="text"
            autocomplete="off"
            placeholder="証拠テキスト"
            bind:value={verifyEvidence[index]}
          />
        </div>
      {/each}
    </div>
    <button
      id="handoff-verify"
      type="button"
      disabled={!flags?.verifiable}
      onclick={() => void commitVerify()}
    >
      検証する
    </button>
    <button
      id="handoff-fail"
      type="button"
      disabled={!flags?.active}
      onclick={() => void commitMutation("fail")}
    >
      失敗にする
    </button>
    <button
      id="handoff-cancel"
      type="button"
      disabled={!flags?.cancellable}
      onclick={() => void commitMutation("cancel")}
    >
      取消する
    </button>
    <button
      id="handoff-abnormal"
      type="button"
      disabled={!flags?.active}
      onclick={() => void commitMutation("abnormal-exit")}
    >
      異常終了を記録
    </button>
    <select id="handoff-attempt-cause" bind:value={attemptCause}>
      <option value="transient_infra">一時的障害</option>
      <option value="worker_error">作業者エラー</option>
      <option value="criteria_unmet">条件未達</option>
      <option value="environment">環境要因</option>
    </select>
    <button
      id="handoff-attempt"
      type="button"
      disabled={!flags?.retryable}
      onclick={() => void commitAttempt()}
    >
      再試行を記録
    </button>
    <button
      id="handoff-reaffirm"
      type="button"
      disabled={!flags?.reaffirmAble}
      onclick={() => void commitMutation("reaffirm")}
    >
      再確認する
    </button>
    <button
      id="handoff-spec"
      type="button"
      disabled={opInFlight || pendingOp !== null}
      onclick={() => void exportSpec()}
    >
      仕様を取得
    </button>
    <div id="handoff-spec-view">
      {#if specText !== null}
        <pre>{specText}</pre>
        <button type="button" onclick={() => copySpec()}>
          仕様をコピー（手動でpi-orchへ貼り付け）
        </button>
      {/if}
    </div>
  </div>
  <!-- The frozen-request retry + op status belong to the section, NOT
       the detail drawer: the drawer stays hidden until a handoff is
       selected, so a retry nested inside it could never be pressed
       after an uncertain POST with no selection. -->
  <button
    id="handoff-retry"
    type="button"
    hidden={retryHidden}
    onclick={() => void retryPendingOp()}
  >
    同じ内容で再送
  </button>
  <p id="handoff-status" aria-live="polite">{statusText}</p>
</section>
