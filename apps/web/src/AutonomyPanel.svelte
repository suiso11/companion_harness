<script lang="ts">
// PR-5 native autonomy page (port of the legacy AutonomyPanel in
// `apps/server/src/ui/client.ts` ~AutonomyPanel, markup from `ui/page.ts`).
//
// Same public API + DOM ids as the legacy panel, so the e2e specs run
// unchanged. Boundaries preserved exactly:
// - Session-owned purposes + explicit local tasks + the durable global stop
//   control (GET/POST /api/autonomy/control with CAS expectedVersion).
// - Every mutation carries a frozen idempotency key + frozen body (one
//   in-memory pending command, retried with the SAME key + byte-identical
//   body on uncertain network / 5xx; cleared ONLY on a definitive reply;
//   a new target draft never reuses the old key; bodies never localStorage).
// - Technical UUIDs are never rendered: rows show statement/title text plus
//   kind/status labels; generations guard every awaited response.
// - Corrections build from the SELECTED record metadata (scope/kind/
//   provenance), never from the creation form; the applicability window is
//   preserved (omitted) unless the correction inputs set/clear it
//   ("clear" = null). Raw window text is sent verbatim (no local
//   reinterpretation).
// - Hold needs BOTH a reason and a separate reconsideration trigger; resume
//   takes a closed evidence-kind select plus an optional explicit
//   replacement parent (the currently selected purpose when the checkbox
//   is on — never automatic).
// - Recorded `permission` rows are claims only (fixed note): the form never
//   creates a grant, a capability, or an external action.
// - Conflict marking is a two-step arm/submit on visible selections; an arm
//   that is no longer active is re-armed; a 409 resets the dead arm.
// - History trails render the immutable original / correction / lifecycle
//   rows with bounded lossy-free paging (afterSeq cursor per target).
// Every model string renders via text interpolation only (no {@html}).

import { fetchJson, postJson, randomUuid } from "./lib/api.js";
import { notifyAutonomyChanged } from "./lib/autonomy.svelte.js";
import {
  AUTONOMY_CONTROL_PATH,
  buildControlBody,
  fetchAutonomyControl,
} from "./lib/autonomy_control.js";
import {
  CONFIRM_GOAL_LABEL,
  goalConfirmPath,
  isConversationAdoptedGoal,
  UNCONFIRMED_GOAL_BADGE,
} from "./lib/goal_confirm.js";
import { revealHashTarget } from "./lib/router.js";
import { getSessionId } from "./lib/session.svelte.js";

interface PurposeRow {
  readonly id: string;
  readonly statement: string;
  readonly kind: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly version: number;
  readonly explicit: boolean;
  readonly sourceKind: string;
}

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly deadline: string;
  readonly version: number;
}

interface PurposeView {
  scope: string;
  kind: string;
  explicit: boolean;
  sourceKind: string;
  interpretation: string | null;
  version: number;
}

interface TaskView {
  scope: string;
  parentPurposeId: string | null;
  version: number;
}

interface PendingCommand {
  session: string;
  endpoint: string;
  key: string;
  body: unknown;
}

/** Legacy `retryRefreshesControl` (autonomy_state.ts). */
function retryRefreshesControl(endpoint: string): boolean {
  return endpoint === AUTONOMY_CONTROL_PATH;
}

/** Legacy `revalidateConflictArm`: an arm that left the active set is dropped. */
function revalidateConflictArm(
  arm: string | null,
  activeIds: ReadonlySet<string>,
): string | null {
  if (arm !== null && !activeIds.has(arm)) return null;
  return arm;
}

/** Legacy `shouldResetConflictArm`: a rejected pair resets the dead arm. */
function shouldResetConflictArm(status: number): boolean {
  return status === 409;
}

function formatHistoryEvents(events: unknown, withNote: boolean): string[] {
  if (!Array.isArray(events)) return [];
  const lines: string[] = [];
  for (const entry of events) {
    const row = entry as {
      seq?: unknown;
      event?: unknown;
      fromStatus?: unknown;
      toStatus?: unknown;
      note?: unknown;
    };
    if (typeof row.seq !== "number" || typeof row.event !== "string") continue;
    const from = typeof row.fromStatus === "string" ? row.fromStatus : "−";
    const to = typeof row.toStatus === "string" ? row.toStatus : "";
    const note =
      withNote && typeof row.note === "string" && row.note.length > 0
        ? ` ${row.note}`
        : "";
    lines.push(`#${row.seq} ${row.event}（${from}→${to}）${note}`);
  }
  return lines;
}

let statusText = $state("");
let controlStatus = $state("");
let pendingLine = $state("");
let conflictsText = $state("");
let purposes = $state<PurposeRow[]>([]);
let tasks = $state<TaskRow[]>([]);
let purposeDetailVisible = $state(false);
let purposeDetailBody = $state("");
let taskDetailVisible = $state(false);
let taskDetailBody = $state("");
let purposeHistoryMoreVisible = $state(false);
let taskHistoryMoreVisible = $state(false);

// Creation form drafts.
let purposeScope = $state("");
let purposeStatement = $state("");
let purposeKind = $state("goal");
let purposeSource = $state("user");
let purposeExplicit = $state(true);
let purposeInterpretation = $state("");
let purposeValidFrom = $state("");
let purposeValidUntil = $state("");
// Purpose correction drafts.
let purposeCorrectInput = $state("");
let purposeCorrectValidFrom = $state("");
let purposeCorrectValidUntil = $state("");
// Task creation form drafts.
let taskTitle = $state("");
let taskKind = $state("chat");
let taskSpeaker = $state("user");
let taskScope = $state("");
let taskParentMode = $state("attached");
let taskDeadline = $state("");
// Task hold/resume drafts.
let taskHoldInput = $state("");
let taskReconsiderInput = $state("");
let taskEvidenceKind = $state("user_confirmed");
let taskResumeInput = $state("");
let taskResumeUseParent = $state(false);

let selectedPurpose = $state<string | null>(null);
let selectedTask = $state<string | null>(null);

// Non-reactive generation / CAS state (same contract as the legacy panel).
let controlVersion = 1;
const purposeVersions = new Map<string, number>();
const purposeActiveIds = new Set<string>();
const taskVersions = new Map<string, number>();
let selectedPurposeView: PurposeView | null = null;
let selectedTaskView: TaskView | null = null;
let listSeq = 0;
let controlSeq = 0;
let purposeSelectSeq = 0;
let taskSelectSeq = 0;
let listedSession: string | null = null;
let mutating = false;
let pendingAutonomy: PendingCommand | null = null;
let conflictArm: string | null = null;
let purposeHistoryCursor: number | null = null;
let taskHistoryCursor: number | null = null;
let purposeHistorySession: string | null = null;
let purposeHistoryTarget: string | null = null;
let taskHistorySession: string | null = null;
let taskHistoryTarget: string | null = null;

function notice(text: string): void {
  statusText = text;
}

function renderPending(): void {
  pendingLine =
    pendingAutonomy === null
      ? ""
      : "未確定の操作があります。同じ内容で再送できます（新規操作は確定までお待ちください）";
}

function clearPurposeDrafts(): void {
  purposeCorrectInput = "";
  purposeCorrectValidFrom = "";
  purposeCorrectValidUntil = "";
}

function clearTaskDrafts(): void {
  taskHoldInput = "";
  taskReconsiderInput = "";
  taskResumeInput = "";
}

/**
 * Frozen-command mutation helper (UI5): one in-memory pending command
 * { session, endpoint, key, FROZEN body }; same-key byte-identical retry on
 * uncertain network / 5xx; cleared ONLY on a definitive reply (2xx/4xx).
 */
async function runAutonomyMutation(
  endpoint: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const sessionId = getSessionId();
  if (sessionId === null || mutating) return null;
  if (pendingAutonomy !== null) {
    notice("未確定の操作があります。同じ内容で再送してください");
    renderPending();
    return null;
  }
  const key = randomUuid();
  // Deep-freeze the body snapshot: retries reuse this exact object.
  const frozen = JSON.parse(JSON.stringify(body)) as unknown;
  pendingAutonomy = { session: sessionId, endpoint, key, body: frozen };
  mutating = true;
  renderPending();
  try {
    let result: { status: number; body: unknown };
    try {
      result = await postJson(endpoint, frozen, key);
    } catch {
      notice("通信が不確定です。同じ内容で再送できます");
      return null;
    }
    // status 0 = network-level failure surfaced as a value (api.ts): the
    // outcome is unknown, so it is treated EXACTLY like the throw path above
    // (uncertain; the frozen command survives with the same idempotency key).
    if (result.status === 0) {
      notice("通信が不確定です。同じ内容で再送できます");
      return null;
    }
    if (result.status >= 500) {
      notice("サーバーが不確定です。同じ内容で再送できます");
      return null;
    }
    pendingAutonomy = null;
    renderPending();
    return result;
  } finally {
    mutating = false;
  }
}

/** Explicit same-key retry of the frozen pending command (no new key). */
async function retryPendingAutonomy(): Promise<void> {
  const pending = pendingAutonomy;
  const sessionId = getSessionId();
  if (
    pending === null ||
    sessionId === null ||
    mutating ||
    pending.session !== sessionId
  ) {
    return;
  }
  mutating = true;
  try {
    let result: { status: number; body: unknown };
    try {
      result = await postJson(pending.endpoint, pending.body, pending.key);
    } catch {
      notice("通信が不確定です。同じ内容で再送できます");
      return;
    }
    // status 0 = uncertain network loss (see runAutonomyMutation): keep the
    // pending command + retry affordance, exactly like the throw path.
    if (result.status === 0) {
      notice("通信が不確定です。同じ内容で再送できます");
      return;
    }
    if (result.status >= 500) {
      notice("サーバーが不確定です。同じ内容で再送できます");
      return;
    }
    pendingAutonomy = null;
    renderPending();
    if (retryRefreshesControl(pending.endpoint)) await refreshControl();
    await refreshLists();
    notice("再送しました");
  } finally {
    mutating = false;
  }
}

async function refreshControl(): Promise<void> {
  const seq = ++controlSeq;
  // Session binding: the response applies only while the same session still
  // holds (a boot/rebind before the fetch lands must discard this token).
  const sessionId = getSessionId();
  const snapshot = await fetchAutonomyControl();
  if (seq !== controlSeq || getSessionId() !== sessionId) return;
  if (snapshot === null) return;
  controlVersion = snapshot.version;
  controlStatus = snapshot.paused
    ? "自律動作は停止中です。通常の会話は利用できます。／自律作業は停止中です。通常の会話は利用できます。"
    : "自律動作は再開されています。通常の会話は利用できます。／自律作業は再開されています。通常の会話は利用できます。";
}

async function setControl(paused: boolean): Promise<void> {
  const result = await runAutonomyMutation(
    AUTONOMY_CONTROL_PATH,
    buildControlBody(paused, controlVersion),
  );
  if (result === null) return;
  if (result.status === 200) {
    await refreshControl();
    notice(
      paused
        ? "自律動作を停止しました／自律作業を停止しました"
        : "自律動作を再開しました／自律作業を再開しました",
    );
  } else if (result.status === 409) {
    await refreshControl();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice(
      "自律動作の切り替えに失敗しました／自律作業の切り替えに失敗しました",
    );
  }
}

async function refreshLists(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  // Session guard (UI4): a session switch clears selections + drafts.
  if (listedSession !== null && listedSession !== sessionId) {
    selectedPurpose = null;
    selectedPurposeView = null;
    selectedTask = null;
    selectedTaskView = null;
    conflictArm = null;
    clearPurposeDrafts();
    clearTaskDrafts();
    purposeHistoryCursor = null;
    taskHistoryCursor = null;
    purposeHistorySession = null;
    taskHistorySession = null;
    purposeHistoryTarget = null;
    taskHistoryTarget = null;
    purposeHistoryMoreVisible = false;
    taskHistoryMoreVisible = false;
  }
  listedSession = sessionId;
  const seq = ++listSeq;
  let purposesResult: { status: number; body: unknown };
  let tasksResult: { status: number; body: unknown };
  let conflicts: { status: number; body: unknown };
  try {
    const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
    [purposesResult, tasksResult, conflicts] = await Promise.all([
      fetchJson(`${base}/purposes?limit=50`),
      fetchJson(`${base}/tasks?limit=50`),
      fetchJson(`${base}/purpose-conflicts`),
    ]);
  } catch {
    return;
  }
  if (seq !== listSeq || getSessionId() !== sessionId) return;
  renderPurposes(purposesResult);
  renderTasks(tasksResult);
  renderConflicts(conflicts);
  // Deep-link reveal: /learning source links land on /tasks#<record id>;
  // scroll/focus that row once both lists have rendered (retries until
  // the data load finishes).
  revealHashTarget();
}

function renderPurposes(result: { status: number; body: unknown }): void {
  const items =
    ((result.body as { items?: unknown }).items as unknown[] | undefined) ?? [];
  if (result.status !== 200 || !Array.isArray(items)) return;
  const rows: PurposeRow[] = [];
  purposeVersions.clear();
  purposeActiveIds.clear();
  for (const item of items) {
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.statement !== "string" ||
      typeof row.kind !== "string" ||
      typeof row.status !== "string" ||
      typeof row.version !== "number"
    ) {
      continue;
    }
    purposeVersions.set(row.id, row.version);
    if (row.status === "active") purposeActiveIds.add(row.id);
    rows.push({
      id: row.id,
      statement: row.statement,
      kind: row.kind,
      status: row.status,
      validFrom: typeof row.validFrom === "string" ? row.validFrom : "",
      validUntil: typeof row.validUntil === "string" ? row.validUntil : "",
      version: row.version,
      explicit: row.explicit === true,
      sourceKind: typeof row.sourceKind === "string" ? row.sourceKind : "user",
    });
  }
  purposes = rows;
  // Rebind (never blindly hide): a vanished selected id clears the
  // selection AND its drafts so a stale draft can never overwrite a target.
  if (selectedPurpose !== null) {
    if (purposeVersions.has(selectedPurpose)) {
      purposeDetailVisible = true;
    } else {
      selectedPurpose = null;
      selectedPurposeView = null;
      conflictArm = null;
      clearPurposeDrafts();
      purposeDetailVisible = false;
    }
  }
}

function renderTasks(result: { status: number; body: unknown }): void {
  const items =
    ((result.body as { items?: unknown }).items as unknown[] | undefined) ?? [];
  if (result.status !== 200 || !Array.isArray(items)) return;
  const rows: TaskRow[] = [];
  taskVersions.clear();
  for (const item of items) {
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.kind !== "string" ||
      typeof row.status !== "string" ||
      typeof row.version !== "number"
    ) {
      continue;
    }
    taskVersions.set(row.id, row.version);
    rows.push({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      deadline: typeof row.deadline === "string" ? row.deadline : "",
      version: row.version,
    });
  }
  tasks = rows;
  if (selectedTask !== null) {
    if (taskVersions.has(selectedTask)) {
      taskDetailVisible = true;
    } else {
      selectedTask = null;
      selectedTaskView = null;
      clearTaskDrafts();
      taskDetailVisible = false;
    }
  }
}

function renderConflicts(result: { status: number; body: unknown }): void {
  if (result.status !== 200) {
    conflictsText = "";
    return;
  }
  const groups =
    ((result.body as { conflicts?: unknown }).conflicts as
      | unknown[]
      | undefined) ?? [];
  if (!Array.isArray(groups) || groups.length === 0) {
    conflictsText = "競合はありません";
    return;
  }
  conflictsText = `${groups.length}件の未解決の競合があります（自動解決されません）`;
}

async function selectPurpose(id: string): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  // Synchronous rebind BEFORE the first await: drafts + history paging
  // belong to the exact selected id/version.
  const seq = ++purposeSelectSeq;
  selectedPurpose = id;
  selectedPurposeView = null;
  clearPurposeDrafts();
  purposeHistoryCursor = null;
  purposeHistorySession = sessionId;
  purposeHistoryTarget = id;
  purposeHistoryMoreVisible = false;
  let result: { status: number; body: unknown };
  let history: { status: number; body: unknown } | null = null;
  try {
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/purposes/${encodeURIComponent(id)}`;
    result = await fetchJson(base);
    try {
      history = await fetchJson(`${base}/history?limit=50`);
    } catch {
      history = null;
    }
  } catch {
    return;
  }
  if (result.status !== 200) return;
  const row = result.body as Record<string, unknown>;
  if (typeof row.statement !== "string" || typeof row.version !== "number") {
    return;
  }
  // Late-response guard: discard unless this exact session+selection holds.
  if (
    seq !== purposeSelectSeq ||
    selectedPurpose !== id ||
    getSessionId() !== sessionId
  ) {
    return;
  }
  selectedPurposeView = {
    scope: typeof row.scope === "string" ? row.scope : "default",
    kind: typeof row.kind === "string" ? row.kind : "goal",
    explicit: row.explicit === true,
    sourceKind: typeof row.sourceKind === "string" ? row.sourceKind : "user",
    interpretation:
      typeof row.interpretation === "string" ? row.interpretation : null,
    version: row.version,
  };
  purposeVersions.set(id, row.version);
  const explicitLabel = row.explicit === true ? "本人の記録" : "推測の記録";
  const fromLabel =
    typeof row.validFrom === "string" && row.validFrom.length > 0
      ? row.validFrom
      : "指定なし";
  const untilLabel =
    typeof row.validUntil === "string" && row.validUntil.length > 0
      ? row.validUntil
      : "指定なし";
  const interpretation =
    typeof row.interpretation === "string" ? row.interpretation : "";
  purposeDetailBody =
    `【${typeof row.kind === "string" ? row.kind : ""}・${typeof row.status === "string" ? row.status : ""}】${row.statement}\n` +
    `出所: ${explicitLabel}（${selectedPurposeView.sourceKind}） 範囲: ${selectedPurposeView.scope}\n` +
    `適用期間: ${fromLabel} 〜 ${untilLabel}\n` +
    (interpretation.length > 0 ? `解釈: ${interpretation}\n` : "") +
    "許可の記録は主張のみで、権限の付与ではありません。";
  if (history !== null && history.status === 200) {
    const lines = formatHistoryEvents(
      (history.body as { events?: unknown }).events,
      false,
    );
    if (lines.length > 0) {
      purposeDetailBody += `\n履歴:\n${lines.join("\n")}`;
    }
    const next = (history.body as { nextAfterSeq?: unknown }).nextAfterSeq;
    if (typeof next === "number" && Number.isInteger(next) && next >= 1) {
      purposeHistoryCursor = next;
      purposeHistoryMoreVisible = true;
    } else {
      purposeHistoryCursor = null;
      purposeHistoryMoreVisible = false;
    }
  } else {
    purposeHistoryCursor = null;
    purposeHistoryMoreVisible = false;
  }
  purposeDetailVisible = true;
}

async function loadMorePurposeHistory(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedPurpose;
  const cursor = purposeHistoryCursor;
  const seq = purposeSelectSeq;
  if (
    sessionId === null ||
    id === null ||
    cursor === null ||
    purposeHistorySession !== sessionId ||
    purposeHistoryTarget !== id
  ) {
    return;
  }
  let page: { status: number; body: unknown };
  try {
    page = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/purposes/${encodeURIComponent(id)}/history?afterSeq=${cursor}&limit=50`,
    );
  } catch {
    return;
  }
  if (
    seq !== purposeSelectSeq ||
    selectedPurpose !== id ||
    getSessionId() !== sessionId ||
    purposeHistoryTarget !== id ||
    purposeHistoryCursor !== cursor
  ) {
    return;
  }
  if (page.status !== 200) return;
  const lines = formatHistoryEvents(
    (page.body as { events?: unknown }).events,
    false,
  );
  if (lines.length > 0) {
    purposeDetailBody += `\n履歴:\n${lines.join("\n")}`;
  }
  const next = (page.body as { nextAfterSeq?: unknown }).nextAfterSeq;
  if (typeof next === "number" && Number.isInteger(next) && next >= 1) {
    purposeHistoryCursor = next;
    purposeHistoryMoreVisible = true;
  } else {
    purposeHistoryCursor = null;
    purposeHistoryMoreVisible = false;
  }
}

async function selectTask(id: string): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const seq = ++taskSelectSeq;
  selectedTask = id;
  selectedTaskView = null;
  clearTaskDrafts();
  taskHistoryCursor = null;
  taskHistorySession = sessionId;
  taskHistoryTarget = id;
  taskHistoryMoreVisible = false;
  let result: { status: number; body: unknown };
  let history: { status: number; body: unknown } | null = null;
  try {
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}`;
    result = await fetchJson(base);
    try {
      history = await fetchJson(`${base}/history?limit=50`);
    } catch {
      history = null;
    }
  } catch {
    return;
  }
  if (result.status !== 200) return;
  const row = result.body as Record<string, unknown>;
  if (typeof row.title !== "string" || typeof row.version !== "number") {
    return;
  }
  if (
    seq !== taskSelectSeq ||
    selectedTask !== id ||
    getSessionId() !== sessionId
  ) {
    return;
  }
  selectedTaskView = {
    scope: typeof row.scope === "string" ? row.scope : "default",
    parentPurposeId:
      typeof row.parentPurposeId === "string" ? row.parentPurposeId : null,
    version: row.version,
  };
  taskVersions.set(id, row.version);
  const deadline =
    typeof row.deadline === "string" && row.deadline.length > 0
      ? `\n期限: ${row.deadline}`
      : "";
  const hold =
    typeof row.holdReason === "string" && row.holdReason.length > 0
      ? `\n保留理由: ${row.holdReason}`
      : "";
  const trigger =
    typeof row.reconsiderTrigger === "string" &&
    row.reconsiderTrigger.length > 0
      ? `\n再開の条件: ${row.reconsiderTrigger}`
      : "";
  taskDetailBody =
    `【${typeof row.kind === "string" ? row.kind : ""}・${typeof row.status === "string" ? row.status : ""}】${row.title}${deadline}${hold}${trigger}\n` +
    "作業はカレンダーと連携しません。期限は入力した値のみです。";
  if (history !== null && history.status === 200) {
    const lines = formatHistoryEvents(
      (history.body as { events?: unknown }).events,
      true,
    );
    if (lines.length > 0) {
      taskDetailBody += `\n履歴:\n${lines.join("\n")}`;
    }
    const next = (history.body as { nextAfterSeq?: unknown }).nextAfterSeq;
    if (typeof next === "number" && Number.isInteger(next) && next >= 1) {
      taskHistoryCursor = next;
      taskHistoryMoreVisible = true;
    } else {
      taskHistoryCursor = null;
      taskHistoryMoreVisible = false;
    }
  } else {
    taskHistoryCursor = null;
    taskHistoryMoreVisible = false;
  }
  taskDetailVisible = true;
}

async function loadMoreTaskHistory(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedTask;
  const cursor = taskHistoryCursor;
  const seq = taskSelectSeq;
  if (
    sessionId === null ||
    id === null ||
    cursor === null ||
    taskHistorySession !== sessionId ||
    taskHistoryTarget !== id
  ) {
    return;
  }
  let page: { status: number; body: unknown };
  try {
    page = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}/history?afterSeq=${cursor}&limit=50`,
    );
  } catch {
    return;
  }
  if (
    seq !== taskSelectSeq ||
    selectedTask !== id ||
    getSessionId() !== sessionId ||
    taskHistoryTarget !== id ||
    taskHistoryCursor !== cursor
  ) {
    return;
  }
  if (page.status !== 200) return;
  const lines = formatHistoryEvents(
    (page.body as { events?: unknown }).events,
    true,
  );
  if (lines.length > 0) {
    taskDetailBody += `\n${lines.join("\n")}`;
  }
  const next = (page.body as { nextAfterSeq?: unknown }).nextAfterSeq;
  if (typeof next === "number" && Number.isInteger(next) && next >= 1) {
    taskHistoryCursor = next;
    taskHistoryMoreVisible = true;
  } else {
    taskHistoryCursor = null;
    taskHistoryMoreVisible = false;
  }
}

async function createPurpose(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const statement = purposeStatement.trim();
  const scope =
    purposeScope.trim().length > 0 ? purposeScope.trim() : "default";
  if (statement.length === 0) {
    notice("目的の内容を入力してください");
    return;
  }
  const body: Record<string, unknown> = {
    scope,
    statement,
    kind: purposeKind,
    explicit: purposeExplicit,
    sourceKind: purposeSource,
  };
  const interpretation = purposeInterpretation.trim();
  if (interpretation.length > 0) body.interpretation = interpretation;
  // Raw window text is sent verbatim (server validates strict RFC3339).
  const validFrom = purposeValidFrom.trim();
  if (validFrom.length > 0) body.validFrom = validFrom;
  const validUntil = purposeValidUntil.trim();
  if (validUntil.length > 0) body.validUntil = validUntil;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/purposes`,
    body,
  );
  if (result === null) return;
  if (result.status === 201) {
    purposeStatement = "";
    purposeInterpretation = "";
    purposeValidFrom = "";
    purposeValidUntil = "";
    await refreshLists();
    notifyAutonomyChanged();
    notice("目的を記録しました");
  } else {
    notice("目的の記録に失敗しました");
  }
}

async function correctPurpose(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedPurpose;
  const selected = selectedPurposeView;
  if (sessionId === null || id === null || selected === null) {
    notice("訂正する目的を選んでください");
    return;
  }
  // Generation guard: the draft belongs to the exact selected id/version.
  if (purposeVersions.get(id) !== selected.version) {
    notice("他の変更がありました。一覧を更新しました");
    await refreshLists();
    return;
  }
  const statement = purposeCorrectInput.trim();
  if (statement.length === 0) {
    notice("訂正内容を入力してください");
    return;
  }
  // UI1: build from the SELECTED record metadata, never the creation form;
  // the window is preserved (omitted) unless explicitly set/cleared.
  const body: Record<string, unknown> = {
    expectedVersion: selected.version,
    scope: selected.scope,
    statement,
    kind: selected.kind,
    explicit: selected.explicit,
    sourceKind: selected.sourceKind,
  };
  if (selected.interpretation !== null) {
    body.interpretation = selected.interpretation;
  }
  const parseWindow = (raw: string): string | null | undefined => {
    const text = raw.trim();
    if (text.length === 0) return undefined;
    if (text === "clear") return null;
    return text;
  };
  const nextFrom = parseWindow(purposeCorrectValidFrom);
  if (nextFrom !== undefined) body.validFrom = nextFrom;
  const nextUntil = parseWindow(purposeCorrectValidUntil);
  if (nextUntil !== undefined) body.validUntil = nextUntil;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/purposes/${encodeURIComponent(id)}/correct`,
    body,
  );
  if (result === null) return;
  if (result.status === 201) {
    purposeCorrectInput = "";
    purposeCorrectValidFrom = "";
    purposeCorrectValidUntil = "";
    await refreshLists();
    // Select the appended NEW record (superseded original stays readable).
    const current = (result.body as { current?: { id?: unknown } }).current;
    const old = (result.body as { old?: { statement?: unknown } }).old;
    if (typeof current?.id === "string") {
      await selectPurpose(current.id);
      if (typeof old?.statement === "string") {
        purposeDetailBody += `\n元の記録: ${old.statement}`;
      }
    }
    notice("訂正を記録しました（元の記録は残ります）");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("訂正の記録に失敗しました");
  }
}

async function transitionPurpose(op: "revoke" | "achieve"): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedPurpose;
  if (sessionId === null || id === null) return;
  const selected = selectedPurposeView;
  if (selected !== null && purposeVersions.get(id) !== selected.version) {
    notice("他の変更がありました。一覧を更新しました");
    await refreshLists();
    return;
  }
  const version = selected?.version ?? purposeVersions.get(id) ?? 1;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/purposes/${encodeURIComponent(id)}/${op}`,
    { expectedVersion: version },
  );
  if (result === null) return;
  if (result.status === 200) {
    await refreshLists();
    notifyAutonomyChanged();
    notice(op === "revoke" ? "目的を取り消しました" : "目的を達成にしました");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("目的の更新に失敗しました");
  }
}

/** Human confirmation of a chat-adopted goal (badge → button). */
async function confirmGoal(id: string): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const version = purposeVersions.get(id);
  if (version === undefined) {
    await refreshLists();
    return;
  }
  const result = await runAutonomyMutation(goalConfirmPath(sessionId, id), {
    expectedVersion: version,
  });
  if (result === null) return;
  if (result.status === 200) {
    await refreshLists();
    notifyAutonomyChanged();
    notice("自分の目的として確定しました");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("目的の確定に失敗しました");
  }
}

async function markConflict(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedPurpose;
  if (sessionId === null || id === null) {
    notice("競合にする目的を二つ選んでください");
    return;
  }
  conflictArm = revalidateConflictArm(conflictArm, purposeActiveIds);
  if (conflictArm !== null && !purposeVersions.has(conflictArm)) {
    conflictArm = null;
  }
  if (conflictArm === null) {
    conflictArm = id;
    notice("競合の起点を保持しました。もう一方を選んで再度押してください");
    return;
  }
  if (conflictArm === id) {
    notice("異なる目的を二つ選んでください");
    return;
  }
  const pair = { purposeAId: conflictArm, purposeBId: id };
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/purpose-conflicts`,
    pair,
  );
  if (result === null) return;
  if (result.status === 201 || result.status === 200) {
    conflictArm = null;
    await refreshLists();
    notice("競合を記録しました（自動解決されません）");
  } else if (result.status === 409) {
    if (shouldResetConflictArm(result.status)) conflictArm = null;
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("競合の記録に失敗しました");
  }
}

async function createTask(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const title = taskTitle.trim();
  if (title.length === 0) {
    notice("作業の内容を入力してください");
    return;
  }
  // UI2: explicit standalone/parent control. "attached" requires a visible
  // selected purpose and takes its scope unless a typed scope is present.
  const mode = taskParentMode;
  const typedScope = taskScope.trim();
  let scope = typedScope.length > 0 ? typedScope : "default";
  let parent: string | null = null;
  if (mode === "standalone") {
    parent = null;
  } else {
    const selected = selectedPurpose;
    const view = selectedPurposeView;
    if (selected === null || view === null) {
      notice("結びつける目的を選ぶか、単独を選んでください");
      return;
    }
    if (!purposeVersions.has(selected)) {
      notice("選択中の目的が一覧にありません。選び直してください");
      return;
    }
    parent = selected;
    if (typedScope.length === 0) scope = view.scope;
  }
  const body: Record<string, unknown> = {
    scope,
    title,
    kind: taskKind,
    speaker: taskSpeaker,
  };
  const deadline = taskDeadline.trim();
  if (deadline.length > 0) body.deadline = deadline;
  if (parent !== null) body.parentPurposeId = parent;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
    body,
  );
  if (result === null) return;
  if (result.status === 201) {
    taskTitle = "";
    taskDeadline = "";
    await refreshLists();
    notifyAutonomyChanged();
    notice("作業を記録しました");
  } else {
    notice("作業の記録に失敗しました");
  }
}

async function transitionTask(
  op: "start" | "complete" | "cancel",
): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedTask;
  if (sessionId === null || id === null) return;
  const view = selectedTaskView;
  if (view !== null && taskVersions.get(id) !== view.version) {
    notice("他の変更がありました。一覧を更新しました");
    await refreshLists();
    return;
  }
  const version = view?.version ?? taskVersions.get(id) ?? 1;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}/${op}`,
    { expectedVersion: version },
  );
  if (result === null) return;
  if (result.status === 200) {
    await refreshLists();
    notifyAutonomyChanged();
    notice("作業を更新しました");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("作業の更新に失敗しました");
  }
}

async function holdTask(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedTask;
  if (sessionId === null || id === null || mutating) return;
  const view = selectedTaskView;
  if (view !== null && taskVersions.get(id) !== view.version) {
    notice("他の変更がありました。一覧を更新しました");
    await refreshLists();
    return;
  }
  // Hold needs BOTH a reason and a separate reconsideration trigger.
  const reason = taskHoldInput.trim();
  const trigger = taskReconsiderInput.trim();
  if (reason.length === 0) {
    notice("保留理由を入力してください");
    return;
  }
  if (trigger.length === 0) {
    notice("再開の条件を入力してください");
    return;
  }
  const version = view?.version ?? taskVersions.get(id) ?? 1;
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}/hold`,
    {
      expectedVersion: version,
      reason,
      reconsiderTrigger: trigger.length > 0 ? trigger : reason,
    },
  );
  if (result === null) return;
  if (result.status === 200) {
    taskHoldInput = "";
    taskReconsiderInput = "";
    await refreshLists();
    notice("作業を保留しました");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("作業の保留に失敗しました");
  }
}

async function resumeTask(): Promise<void> {
  const sessionId = getSessionId();
  const id = selectedTask;
  if (sessionId === null || id === null) return;
  const evidence = taskResumeInput.trim();
  if (evidence.length === 0) {
    notice("再開の根拠を入力してください");
    return;
  }
  const taskView = selectedTaskView;
  if (taskView !== null && taskVersions.get(id) !== taskView.version) {
    notice("他の変更がありました。一覧を更新しました");
    await refreshLists();
    return;
  }
  // Closed evidence-kind vocabulary (no timer member exists).
  const rawKind = taskEvidenceKind;
  const evidenceKind =
    rawKind === "parent_changed" ||
    rawKind === "dependency_completed" ||
    rawKind === "user_confirmed" ||
    rawKind === "correction_applied" ||
    rawKind === "external_input"
      ? rawKind
      : "user_confirmed";
  const version = taskView?.version ?? taskVersions.get(id) ?? 1;
  // UI3: explicit replacement-parent selection (never automatic).
  const body: Record<string, unknown> = {
    expectedVersion: version,
    evidenceKind,
    evidence,
  };
  if (taskResumeUseParent) {
    const replacement = selectedPurpose;
    const view = selectedPurposeView;
    if (replacement === null || view === null) {
      notice("置き換え先の目的を選んでください");
      return;
    }
    if (!purposeVersions.has(replacement)) {
      notice("選択中の目的が一覧にありません。選び直してください");
      return;
    }
    body.newParentPurposeId = replacement;
  }
  const result = await runAutonomyMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}/resume`,
    body,
  );
  if (result === null) return;
  if (result.status === 200) {
    taskResumeInput = "";
    taskResumeUseParent = false;
    await refreshLists();
    notice("作業を再開しました");
  } else if (result.status === 409) {
    await refreshLists();
    notice("他の変更がありました。一覧を更新しました");
  } else {
    notice("作業の再開に失敗しました");
  }
}

// Boot + session rebinding (shared reactive store): reading getSessionId()
// inside this effect tracks the chat session, so the control + list refreshes
// re-run when a session becomes available late (fresh /tasks before the chat
// shell finishes booting) AND on every session switch. A switch resets the
// previous session's selections, details, CAS versions, history cursors and
// the frozen pending command, so stale rows/controls from the old session are
// never shown while mutations target the newly selected one.
$effect(() => {
  getSessionId();
  selectedPurpose = null;
  selectedTask = null;
  selectedPurposeView = null;
  selectedTaskView = null;
  purposeDetailVisible = false;
  taskDetailVisible = false;
  purposeDetailBody = "";
  taskDetailBody = "";
  purposeHistoryMoreVisible = false;
  taskHistoryMoreVisible = false;
  purposeVersions.clear();
  taskVersions.clear();
  purposeHistoryCursor = null;
  taskHistoryCursor = null;
  pendingAutonomy = null;
  renderPending();
  void refreshControl();
  void refreshLists();
});
</script>

<section id="autonomy" aria-label="自律メモの管理" class="feature-panel">
  <h2>自律メモの管理</h2>
  <div id="autonomy-control">
    <p id="autonomy-control-status" aria-live="polite">{controlStatus}</p>
    <button
      id="autonomy-stop-button"
      type="button"
      onclick={() => void setControl(true)}
    >
      自律動作を止める／自律作業を止める
    </button>
    <button
      id="autonomy-resume-button"
      type="button"
      onclick={() => void setControl(false)}
    >
      自律動作を再開／自律作業を再開
    </button>
  </div>
  <form
    id="autonomy-purpose-form"
    onsubmit={(event) => {
      event.preventDefault();
      void createPurpose();
    }}
  >
    <label>
      範囲
      <input
        id="autonomy-purpose-scope"
        type="text"
        autocomplete="off"
        bind:value={purposeScope}
      />
    </label>
    <label>
      目的の内容
      <textarea id="autonomy-purpose-statement" bind:value={purposeStatement}
      ></textarea>
    </label>
    <label>
      種類
      <select id="autonomy-purpose-kind" bind:value={purposeKind}>
        <option value="goal">目標</option>
        <option value="preference">好み</option>
        <option value="constraint">制約</option>
        <option value="permission">許可の記録</option>
        <option value="wish">希望</option>
        <option value="temporary_state">一時状態</option>
      </select>
    </label>
    <label>
      出所
      <select id="autonomy-purpose-source" bind:value={purposeSource}>
        <option value="user">本人</option>
        <option value="self">記録</option>
        <option value="external">外部</option>
      </select>
    </label>
    <label>
      本人の明示的な記録（外すと推測の記録）
      <input id="autonomy-purpose-explicit" type="checkbox" bind:checked={purposeExplicit} />
    </label>
    <label>
      解釈（元の記録と別に保存）
      <textarea id="autonomy-purpose-interpretation" bind:value={purposeInterpretation}></textarea>
    </label>
    <label>
      適用開始（任意・厳密な日時）
      <input
        id="autonomy-purpose-valid-from"
        type="text"
        autocomplete="off"
        bind:value={purposeValidFrom}
      />
    </label>
    <label>
      適用終了（任意・厳密な日時）
      <input
        id="autonomy-purpose-valid-until"
        type="text"
        autocomplete="off"
        bind:value={purposeValidUntil}
      />
    </label>
    <button id="autonomy-purpose-create" type="submit">目的を記録</button>
  </form>
  <ul id="autonomy-purpose-list">
    {#each purposes as purpose (purpose.id)}
      <li id={purpose.id}>
        <button
          type="button"
          onclick={() => void selectPurpose(purpose.id)}
        >
          {purpose.statement}（{purpose.kind}・{purpose.status}{purpose.validFrom
              .length > 0 || purpose.validUntil.length > 0
            ? `・期間 ${purpose.validFrom.length > 0 ? purpose.validFrom : "指定なし"}〜${purpose.validUntil.length > 0 ? purpose.validUntil : "指定なし"}`
            : ""}）
        </button>
        {#if isConversationAdoptedGoal(purpose)}
          <span class="goal-unconfirmed-badge">{UNCONFIRMED_GOAL_BADGE}</span>
          <button
            id={`autonomy-purpose-confirm-${purpose.id}`}
            type="button"
            onclick={() => void confirmGoal(purpose.id)}
          >
            {CONFIRM_GOAL_LABEL}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  <div id="autonomy-purpose-detail" hidden={!purposeDetailVisible}>
    <pre id="autonomy-purpose-detail-body">{purposeDetailBody}</pre>
    <label>
      訂正内容
      <textarea id="autonomy-purpose-correct-input" bind:value={purposeCorrectInput}></textarea>
    </label>
    <label>
      適用開始の訂正（空で維持・clearで解除）
      <input
        id="autonomy-purpose-correct-valid-from"
        type="text"
        autocomplete="off"
        bind:value={purposeCorrectValidFrom}
      />
    </label>
    <label>
      適用終了の訂正（空で維持・clearで解除）
      <input
        id="autonomy-purpose-correct-valid-until"
        type="text"
        autocomplete="off"
        bind:value={purposeCorrectValidUntil}
      />
    </label>
    <button
      id="autonomy-purpose-correct-button"
      type="button"
      onclick={() => void correctPurpose()}
    >
      訂正を記録
    </button>
    <button
      id="autonomy-purpose-revoke-button"
      type="button"
      onclick={() => void transitionPurpose("revoke")}
    >
      取り消す
    </button>
    <button
      id="autonomy-purpose-achieve-button"
      type="button"
      onclick={() => void transitionPurpose("achieve")}
    >
      達成にする
    </button>
    <button
      id="autonomy-purpose-history-more-button"
      type="button"
      hidden={!purposeHistoryMoreVisible}
      onclick={() => void loadMorePurposeHistory()}
    >
      履歴をもっと見る
    </button>
    <p id="autonomy-conflicts" aria-live="polite">{conflictsText}</p>
    <button
      id="autonomy-conflict-mark-button"
      type="button"
      onclick={() => void markConflict()}
    >
      競合として記録
    </button>
  </div>
  <form
    id="autonomy-task-form"
    onsubmit={(event) => {
      event.preventDefault();
      void createTask();
    }}
  >
    <label>
      作業内容
      <input
        id="autonomy-task-title"
        type="text"
        autocomplete="off"
        bind:value={taskTitle}
      />
    </label>
    <label>
      種類
      <select id="autonomy-task-kind" bind:value={taskKind}>
        <option value="chat">相談</option>
        <option value="wish">希望</option>
        <option value="problem">課題</option>
        <option value="task">作業</option>
      </select>
    </label>
    <label>
      話者
      <select id="autonomy-task-speaker" bind:value={taskSpeaker}>
        <option value="user">本人</option>
        <option value="self">記録</option>
        <option value="external">外部</option>
      </select>
    </label>
    <label>
      範囲
      <input
        id="autonomy-task-scope"
        type="text"
        autocomplete="off"
        bind:value={taskScope}
      />
    </label>
    <label>
      親の目的
      <select id="autonomy-task-parent-mode" bind:value={taskParentMode}>
        <option value="attached">選択中の目的に結びつける</option>
        <option value="standalone">単独で記録</option>
      </select>
    </label>
    <label>
      期限（任意・厳密な日時）
      <input
        id="autonomy-task-deadline"
        type="text"
        autocomplete="off"
        bind:value={taskDeadline}
      />
    </label>
    <button id="autonomy-task-create" type="submit">作業を記録</button>
  </form>
  <ul id="autonomy-task-list">
    {#each tasks as task (task.id)}
      <li id={task.id}>
        <button type="button" onclick={() => void selectTask(task.id)}>
          {task.title}（{task.kind}・{task.status}{task.deadline.length > 0
            ? `・期限 ${task.deadline}`
            : ""}）
        </button>
      </li>
    {/each}
  </ul>
  <div id="autonomy-task-detail" hidden={!taskDetailVisible}>
    <pre id="autonomy-task-detail-body">{taskDetailBody}</pre>
    <label>
      保留理由
      <textarea id="autonomy-task-hold-input" bind:value={taskHoldInput}></textarea>
    </label>
    <label>
      再開の条件
      <textarea id="autonomy-task-reconsider-input" bind:value={taskReconsiderInput}></textarea>
    </label>
    <label>
      再開の根拠の種類
      <select id="autonomy-task-evidence-kind" bind:value={taskEvidenceKind}>
        <option value="user_confirmed">本人が確認</option>
        <option value="parent_changed">親の変更</option>
        <option value="dependency_completed">依存作業の完了</option>
        <option value="correction_applied">訂正の反映</option>
        <option value="external_input">外部からの入力</option>
      </select>
    </label>
    <label>
      再開の根拠
      <textarea id="autonomy-task-resume-input" bind:value={taskResumeInput}></textarea>
    </label>
    <label>
      置き換え先の目的を使う
      <input
        id="autonomy-task-resume-use-parent"
        type="checkbox"
        bind:checked={taskResumeUseParent}
      />
    </label>
    <button
      id="autonomy-task-start-button"
      type="button"
      onclick={() => void transitionTask("start")}
    >
      開始
    </button>
    <button
      id="autonomy-task-hold-button"
      type="button"
      onclick={() => void holdTask()}
    >
      保留
    </button>
    <button
      id="autonomy-task-resume-button"
      type="button"
      onclick={() => void resumeTask()}
    >
      再開
    </button>
    <button
      id="autonomy-task-complete-button"
      type="button"
      onclick={() => void transitionTask("complete")}
    >
      完了
    </button>
    <button
      id="autonomy-task-cancel-button"
      type="button"
      onclick={() => void transitionTask("cancel")}
    >
      中止
    </button>
    <button
      id="autonomy-task-history-more-button"
      type="button"
      hidden={!taskHistoryMoreVisible}
      onclick={() => void loadMoreTaskHistory()}
    >
      履歴をもっと見る
    </button>
  </div>
  <p id="autonomy-status" aria-live="polite">{statusText}</p>
  <p id="autonomy-pending" aria-live="polite">{pendingLine}</p>
  <button
    id="autonomy-retry-button"
    type="button"
    onclick={() => void retryPendingAutonomy()}
  >
    同じ内容で再送
  </button>
</section>
