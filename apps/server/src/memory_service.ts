// Conversation-memory service (server-owned remind integration).
//
// Ownership: this module drives the Companion side of the durable
// event -> remember -> feedback pipeline plus bounded automatic
// cultivation (idle `maintain.distill`). The remind CLI (child process) is
// the ONLY remind interface: Companion never opens, imports, or reads the
// remind DB (see memory_cli.ts). All durable state lives in the Companion
// `memory_outbox` / `memory_exposures` / `memory_grants` tables; the CLI
// idempotency key always equals the outbox job's stable key, so a crash or
// unknown-outcome replay reuses the same key and never mints a duplicate
// write. Stable keys are deterministic v4-shaped UUIDs
// (`stableMemoryJobKey`): re-enqueueing the same logical write dedups
// instead of duplicating.
//
// Lifecycle:
// - Disabled by default: no MemoryConfig means no service, no recall hook,
//   no jobs, no timers (M0/M1/M2 behavior preserved exactly).
// - `start()` drains crash-recovered pending jobs and arms the idle distill
//   timer. `stop()` (shutdown) cancels the timer, aborts in-flight CLI
//   calls, and awaits their termination: no orphaned child survives.
// - Foreground work (intake/completion/cancel via `notifyForeground`)
//   preempts an in-flight idle drain: in-flight CLI calls are hard-killed
//   and their jobs return to pending with bounded backoff (durable retry,
//   never infinite: `failMemoryJob` caps attempts, then the job stays
//   failed). Only one idle drain is ever in flight (single flight); idle
//   distill is never duplicated while a distill job is still pending.
// - `onRunCompleted(runId)` runs after the engine durably completes a run.
//   It enforces authoritative guards BEFORE any CLI call: the run must be
//   `completed` with a result AND the turn's current selection must still be
//   this run (a superseded retry never cultivates). Cancelled/stopped runs
//   never reach extraction or feedback. Extraction itself cannot mutate a
//   run: it only reads the frozen turn/result and calls the LOCAL gateway.
// - Feedback is granted ONLY for structural `mN` citations present in the
//   ACCEPTED completed answer's citation arrays (never prose, never mere
//   exposure or textual mention). Each cited `mN` must resolve to a
//   same-run exposure with a matching scope; cross-run or cross-scope
//   citations grant nothing and send no feedback.
// - Structured AI extraction runs through the EXISTING local model gateway
//   (no new service, no provisioning, no network sends beyond the
//   configured loopback gateway). A missing gateway, a timeout, or any
//   invalid extraction JSON conservatively yields NO memory (fail-closed
//   cultivation, fail-open answering: the run itself is never affected).
//
// Logging: fixed codes plus numeric sizes/durations and run ids only (via
// the server logger's whitelisted fields). No conversation text, scopes,
// paths, CLI bodies, or raw errors are ever logged.

import { createHash, randomUUID } from "node:crypto";
import {
  collectCitedMemoryOrdinals,
  formatZonedDateTime,
  isCanonicalIsoInstant,
  type KernelRepository,
  type MemoryMaintenanceOp,
} from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import {
  BACKGROUND_OWNER_MEMORY_EXTRACTION,
  BACKGROUND_OWNER_MEMORY_IDLE_DISTILL,
  type BackgroundResourceGate,
} from "./background_resource.js";
import {
  escapeExtractionDelimiters,
  isGroundedExtractionQuote,
  unescapeExtractionDelimiters,
} from "./extraction_grounding.js";
import type { ServerLogger } from "./logger.js";
import {
  callMemoryCli,
  type MemoryCliAddress,
  type MemoryCliEnvelope,
  MemoryCliError,
  type MemoryCliFailureCode,
} from "./memory_cli.js";

/** Long-budget deadline for one idle distill CLI call (bounded, abortable). */
export const MEMORY_DISTILL_TIMEOUT_MS = 120_000;
/**
 * SEPARATE budget for the post-completion extraction MODEL call (bounded,
 * abortable). Never the CLI `timeoutMs`: a local reasoning model (e.g.
 * Gemma with reasoning enabled) routinely exceeds one CLI-call deadline,
 * and bounding the extraction by the CLI timeout aborted every attempt.
 * Default equals the existing distill step budget; configurable via
 * `COMPANION_MEMORY_JSON` `extractTimeoutMs` (bounds 5000..300000).
 */
export const MEMORY_EXTRACT_TIMEOUT_MS = 120_000;
export const MIN_MEMORY_EXTRACT_TIMEOUT_MS = 5000;
export const MAX_MEMORY_EXTRACT_TIMEOUT_MS = 300_000;
/** Max outbox jobs executed per drain tick (bounded work). */
export const MEMORY_DRAIN_BATCH = 5;
/**
 * Decision (I) "store every turn": bounded idle-window re-cultivation for a
 * run whose extraction was PREEMPTED by foreground activity. After this many
 * retried-then-re-aborted attempts the run gives up with an honest
 * diagnostic (never an infinite loop, never a reset counter); STOP/shutdown
 * aborts never re-schedule at all (no late writes).
 */
export const MEMORY_EXTRACT_RETRY_MAX_ATTEMPTS = 5;
/** Max CLI attempts per outbox job before it stays failed (no infinite retry). */
export const MEMORY_JOB_MAX_ATTEMPTS = 8;
/** Bounds for extraction inputs/outputs (code points). */
export const MEMORY_EXTRACT_INPUT_MAX_CP = 2000;
export const MEMORY_EXTRACT_BODY_MAX_CP = 2000;
export const MEMORY_EXTRACT_MAX_ITEMS = 16;
/**
 * Max length of the verbatim `evidence` quote a model may attach to a
 * `user_fact` item (code points). Longer/missing/invalid evidence is not a
 * hard parse error: the item is kept and downgraded to `model_inference`.
 */
export const MEMORY_EXTRACT_EVIDENCE_MAX_CP = 500;
/**
 * Max length of the persisted `evidence` quote on a `user_fact` item
 * (code points). Remind#41 stores this next to the record; longer grounding
 * quotes are truncated at a code-point boundary before they are sent.
 */
export const MEMORY_EVIDENCE_MAX_CP = 400;
/**
 * Derived topic bounds (remind PR #29): each memory may carry 0..3 short
 * general-category nouns (1..12 code points after NFKC+trim). Remind's
 * record tags are bounded by `tagsMax` (default 5), so extraction topics
 * are sliced before they ride `record.remember` as tags.
 */
export const MEMORY_TOPIC_MAX = 3;
export const MEMORY_TOPIC_MAX_CP = 12;
export const MEMORY_REMIND_TAGS_MAX = 5;
/** Bounded topic backfill page per idle tick (topic.pending limit). */
export const MEMORY_TOPIC_BACKFILL_LIMIT = 8;
/**
 * Bounded activation preview page per idle tick (remind cap is 200).
 * Consolidation does NOT send a limit: remind's `consolidate.batchMax`
 * (default 5) rejects a larger limit with LIMIT_EXCEEDED, so the CLI
 * applies its configured batch size.
 */
export const MEMORY_ACTIVATION_LIMIT = 20;
export const MEMORY_EVENT_BODY_MAX_CP = 4000;
export const MEMORY_RECALL_QUERY_MAX_CP = 500;
/** Fixed provenance source stamped on Companion-written events/records. */
export const MEMORY_PROVENANCE_SOURCE = "companion:conversation";
/** Fixed audit runId marker for pre-answer recall calls (never a real run). */
export const MEMORY_RECALL_RUN_MARKER = "companion-recall";

/** Fixed privacy origin stamped on Companion-written events/records. */
export const MEMORY_PRIVACY_ORIGIN_CONVERSATION = "conversation";
/** Fixed privacy sensitivity for `event.append` (F-I01-05 P5). */
export const MEMORY_PRIVACY_SENSITIVITY_NORMAL = "normal" as const;
export type MemoryPrivacySensitivity = "normal" | "sensitive";

/**
 * Provenance kind on recalled items (F-I01-04). Additive remind field: the
 * extraction kinds are carried as facts/inferences, and `correction`
 * (remind#16) is carried as its own kind and inference-framed downstream —
 * never presented as a fact (F-I01-01/F-I01-04).
 */
export type MemoryRecallItemKind =
  | "user_fact"
  | "model_inference"
  | "summary"
  | "correction";

/** Recall `vector` mode (remind#16, metadata only, never content). */
export type MemoryRecallVector = "disabled" | "used" | "unavailable";

/**
 * One recalled item passed through the recall hook to the agent (kernel
 * `AgentMemorySnippet` shape with additive provenance fields).
 */
export interface MemoryRecallItem {
  readonly recordId: string;
  /** Remind recall id binding this exposure (server-side only). */
  readonly recallId: string;
  readonly snippet: string;
  /** Provenance kind, or undefined when absent or an unknown value. */
  readonly kind?: MemoryRecallItemKind;
  /** Positive safe-integer revision, or undefined when absent/invalid. */
  readonly revision?: number;
  /** Remind record creation instant (ISO-8601), when present and valid. */
  readonly createdAt?: string;
  /** Persisted verbatim quote for a user_fact (remind#41), when present. */
  readonly evidence?: string;
}

/**
 * Explicit management bounds (closed, deterministic).
 *
 * - Search returns at most 8 opaque handles (`m1..mN` in CLI order);
 *   queries are 1..500 code points; correction replacements are 1..2000.
 * - Handles are valid only within the (sessionId, searchId) that created
 *   them: cross-session/cross-scope use fails closed, and historical
 *   snapshots are never rebound to latest memory.
 * - Fixed remind reason codes for explicit user actions: retire stages
 *   `NO_LONGER_USEFUL`, reactivate stages `USER_REQUESTED`. Corrections
 *   always use `kind: "correction"` (never faked as remember/link, never
 *   retired via feedback).
 */
export const MEMORY_SEARCH_LIMIT_MAX = 8;
export const MEMORY_SEARCH_QUERY_MAX_CP = 500;
export const MEMORY_CORRECTION_BODY_MAX_CP = 2000;
export const MEMORY_RETIRE_REASON = "NO_LONGER_USEFUL";
export const MEMORY_REACTIVATE_REASON = "USER_REQUESTED";
export const MEMORY_CORRECT_KIND = "correction";
/**
 * Graph projection bounds (explicit read-only view; never heats):
 * 500 nodes / 4000 edges per response, `graph.page` fetched with a bounded
 * page limit until done or the node cap is reached.
 */
export const MEMORY_GRAPH_NODE_MAX = 500;
export const MEMORY_GRAPH_EDGE_MAX = 4000;
/**
 * `graph.page` default page size. remind's `graphLimitMax` defaults to
 * `rangeLimitMax` (50); a larger limit is LIMIT_EXCEEDED, so the default
 * must stay within that bound. The service still stops at the node cap.
 */
export const MEMORY_GRAPH_PAGE_LIMIT_DEFAULT = 50;
/** Hard stop for a misbehaving remind cursor loop (fixed failure). */
const MEMORY_GRAPH_PAGE_MAX = 100;
export const MEMORY_GRAPH_LABEL_MAX_CP = 512;
/**
 * Memory-content statistics (read-only panel). `record.stats` (remind#42) is
 * the preferred source: one read-only aggregate call with active kind/status
 * counts plus the active importance distribution. Older remind versions
 * reject the unknown op with BAD_REQUEST; the service then latches
 * "stats unsupported" for the process and falls back to bounded
 * `record.list` pages (no importance) with no further stats attempts.
 * `record.list` has no cursor (only `until`), so each status walks
 * newest -> oldest with a fixed row cap; reaching the cap sets `truncated`.
 * The result is cached server-side for five minutes with single-flight so
 * auto-refreshing views do not spawn a CLI child per request.
 */
export const MEMORY_STATS_CACHE_TTL_MS = 300_000;
export const MEMORY_STATS_ACTIVE_ROW_CAP = 300;
export const MEMORY_STATS_STATUS_ROW_CAP = 100;
/** First requested page size; remind may answer LIMIT_EXCEEDED. */
const MEMORY_STATS_PAGE_LIMIT_CANDIDATES: readonly number[] = [
  100, 25, 10, 5, 1,
];
/** Closed extraction kinds (remind RECORD_KINDS subset we ever write). */
const EXTRACT_KINDS: ReadonlySet<string> = new Set([
  "user_fact",
  "model_inference",
  "summary",
]);
/**
 * Closed recall kinds (remind#16): everything extraction may write, plus
 * `correction`, which extraction never emits but recall may deliver. Only
 * `user_fact` is ever presented as a fact; `correction` is stored with its
 * own kind and inference-framed downstream.
 */
const RECALL_KINDS: ReadonlySet<string> = new Set([
  "user_fact",
  "model_inference",
  "summary",
  "correction",
]);

/** Closed extraction sensitivities (F-I01-05 P5; undecidable -> sensitive). */
const EXTRACT_SENSITIVITIES: ReadonlySet<string> = new Set([
  "normal",
  "sensitive",
]);

/** Closed recall vector modes (remind#16; invalid -> absent, metadata only). */
const RECALL_VECTORS: ReadonlySet<string> = new Set([
  "disabled",
  "used",
  "unavailable",
]);

/**
 * Fixed extraction system instruction (deterministic, no conversation).
 * Store-everything policy (decision 2026-10-20: selection happens only at
 * recall time): EVERY turn with non-empty user content yields EXACTLY one
 * `summary` item (concise Japanese digest of the turn — topic, what the
 * user said/asked, what was answered; no judgement of importance) PLUS
 * every user-stated detail as its own `user_fact` (no importance filter:
 * preferences, things mentioned, question topics, events, opinions) PLUS
 * turn-grounded tendencies as `model_inference`. Closed policy kept:
 * user-stated -> user_fact, turn-grounded tendencies -> model_inference,
 * nothing ever phrased as a durable trait from a momentary feeling, no
 * secrets, fail-closed sensitivity.
 */
export const MEMORY_EXTRACT_SYSTEM_PROMPT =
  "Extract memories from the conversation as strict JSON only. " +
  "Respond with exactly one JSON object of the form " +
  '{"memories":[{"body":"...","kind":"...","sensitivity":"...",' +
  '"evidence":"...","topics":["..."]}]} where kind ' +
  "is one of user_fact, model_inference, summary and sensitivity is one of " +
  'normal, sensitive. Each user_fact item MUST also include "evidence": ' +
  "an exact, verbatim, contiguous quote copied from inside the " +
  "<user_message> element that directly supports the body (at most 500 " +
  "characters). Do not paraphrase, translate, correct, or quote from the " +
  "<assistant_message>; omit evidence (or use an empty string) for " +
  "summary and model_inference items. " +
  "Speaker rule: user_fact is ONLY for facts, preferences, plans, " +
  "experiences, or question topics that the USER explicitly stated in " +
  "<user_message>. Anything that appears only in <assistant_message> " +
  "(suggestions, examples, assumptions, interpretations, or the " +
  "assistant's own claims) is NOT a user fact: either omit it or label it " +
  "model_inference. Never restate an assistant claim as a user preference " +
  "or user fact, and never infer evidence for the user from assistant " +
  'wording. Each item MAY also include optional "topics": ' +
  "an array of 0-3 short general-category nouns in the conversation " +
  "language. Topics are categories, not names: replace product, brand, " +
  "person, and place names with the general category they belong to " +
  "(e.g. 「iPhone 15のカメラ」 -> 「スマートフォン」「カメラ」). " +
  "Each topic is 1-12 characters, no sentences; omit topics when none " +
  "apply. " +
  "The conversation is usually Japanese: write each body as a short, " +
  "self-contained Japanese sentence starting with the subject (e.g. " +
  "ユーザーは…) that makes sense on its own. " +
  "Resolve every relative date or time (今日, 明日, 昨日, 一昨日, " +
  "今週の金曜日, 来月, 来週, 先月…) against the current date/time given " +
  "in the user message, and write the resulting ABSOLUTE date " +
  "(YYYY-MM-DD, with the weekday when useful) into the body. " +
  "For any dated event, plan, or schedule include its absolute date. " +
  "Never store a bare relative date without the resolved absolute date. " +
  "ALWAYS include EXACTLY ONE kind=summary item first: a concise Japanese " +
  "summary of THIS turn — the topic, what the user said or asked, and what " +
  "was answered. No judgement of importance: even greetings, small talk " +
  "and one-line questions get a summary. " +
  "Then add ONE user_fact item for EVERY detail the USER explicitly " +
  "stated or asked about in this turn, with no filter of usefulness: " +
  "stated likes, dislikes and preferences (e.g. 好きなバイクの車種・メーカー), " +
  "interests and hobbies, things the user owns or uses, habits and " +
  "routines, plans and goals, events that happened, opinions, momentary " +
  "conditions or feelings the user reported (phrased as what the user " +
  "said today, never as a durable personality trait), and the topics of " +
  "the user's questions. One fact per item: split a multi-part turn into " +
  "separate items. " +
  "Then add at most a few model_inference items: a tendency YOU infer " +
  "from what the user said in THIS turn (e.g. ネイキッド系のバイクを好む傾向が" +
  "ある) — phrase it as a tendency, not certainty, grounded only in this " +
  "turn's words. " +
  "Never store secrets, credentials, or passwords. " +
  "Decide sensitivity at the same step that decides kind: mark sensitive " +
  "anything personal, identifying, credential-like, or touching health, " +
  "finance, relationships, or precise location, or otherwise non-public; " +
  "when undecidable, use sensitive. " +
  "At most 16 items total. No prose, no markdown, JSON only.";

/**
 * Fixed idle topic-backfill system instruction (remind PR #29). Same
 * general-category naming rule as extraction: product/brand/person/place
 * names become the category they belong to, never the name itself. The
 * examples are deliberately generic (no corpus-specific vocabulary). Strict
 * JSON only: `{"topics":[...]}` with 1..3 topics.
 */
export const MEMORY_TOPIC_SYSTEM_PROMPT =
  "Assign 1-3 short general-category topic nouns to the memory. " +
  'Respond with strict JSON only: {"topics":["..."]} with no other ' +
  "keys, no prose, and no markdown. Write topics in the conversation " +
  "language (usually Japanese). Replace product, brand, person, and place " +
  "names with the general category they belong to; for example " +
  "「iPhone 15のカメラ」 -> 「スマートフォン」「カメラ」. Each topic is " +
  "1-12 characters; use common category nouns only, never sentences.";

export interface MemoryServiceOptions {
  readonly address: MemoryCliAddress;
  readonly scope: string;
  readonly recallLimit: number;
  readonly idleMs: number;
  readonly repo: KernelRepository;
  /** Existing LOCAL gateway for structured extraction; null means no extraction. */
  readonly gateway: ModelGateway | null;
  /** Model identifier sent with extraction chat requests (1..256 chars). */
  readonly model: string;
  readonly logger?: ServerLogger;
  readonly now?: () => number;
  /** Injectable CLI call (tests). Defaults to the real bounded client. */
  readonly cliCall?: typeof callMemoryCli;
  /** Injectable distill deadline (tests). Defaults to MEMORY_DISTILL_TIMEOUT_MS. */
  readonly distillTimeoutMs?: number;
  /**
   * SEPARATE extraction model-call budget in ms (tests/bootstrap).
   * Defaults to MEMORY_EXTRACT_TIMEOUT_MS; bounds 5000..300000. Never
   * applied to the CLI `timeoutMs` (address.timeoutMs stays untouched).
   */
  readonly extractTimeoutMs?: number;
  /**
   * `graph.page` page size for the global projection (bounded, tests).
   * Defaults to MEMORY_GRAPH_PAGE_LIMIT_DEFAULT; the service still stops at
   * MEMORY_GRAPH_NODE_MAX regardless.
   */
  readonly graphPageLimit?: number;
  /**
   * Configured IANA time zone (COMPANION_TIME_ZONE). Used as the extraction
   * fallback when a Turn has no frozen temporal; the Turn's frozen temporal
   * wins whenever present.
   */
  readonly timeZone?: string;
  /**
   * Shared background admission (server-owned, bootstrap-injected). When
   * present, post-completion extraction admits ONE unit at a time against
   * the shadow worker, and each automatic `maintain.distill` execution
   * admits the same unit at its own boundary inside `drainOnce` — whatever
   * tick launched it (completion, recovery, idle). Busy/closed skips ONLY
   * the automatic execution with an honest fixed diagnostic (durable
   * pending, attempts unchanged); explicit user-authorized manage work
   * always drains. Absent (default) preserves the legacy ungated behavior.
   * Foreground paths (recall/search/stage) never consult this gate.
   */
  readonly background?: BackgroundResourceGate | null;
  /**
   * Send the optional `evidence` quote on `record.remember` (remind#41).
   * Defaults to true: the pinned remind CLI supports it. Set false to skip
   * the quote up front while running a remind build older than remind#41,
   * whose strict `record.remember` params reject the unknown key with
   * BAD_REQUEST. An older build is also handled at runtime: a BAD_REQUEST
   * on a remember that carried evidence is retried once without it, and the
   * unsupported state is latched for the process (so later remembers omit
   * the quote). Either way a user fact is still stored, just without the
   * original words.
   */
  readonly sendEvidence?: boolean;
}

/** Closed kind counts for ACTIVE records (the only kinds extracted/written). */
export interface MemoryStatsByKind {
  readonly user_fact: number;
  readonly model_inference: number;
  readonly summary: number;
  readonly correction: number;
}

/** Closed status counts (remind record statuses). */
export interface MemoryStatsByStatus {
  readonly active: number;
  readonly retired: number;
  readonly superseded: number;
  readonly archived: number;
}

/** One importance histogram bucket from `record.stats` (`lt` exclusive). */
export interface MemoryStatsImportanceBucket {
  readonly lt: number;
  readonly count: number;
}

/**
 * Active-record importance distribution from `record.stats`. `scored` counts
 * records whose stored importance matches the CURRENT bodyHash; `unscored`
 * counts active records with no fresh score. Bucket counts sum to `scored`.
 */
export interface MemoryStatsImportance {
  readonly scored: number;
  readonly unscored: number;
  readonly buckets: readonly MemoryStatsImportanceBucket[];
}

/**
 * Aggregated memory-content statistics. Numbers only: no snippets, ids, or
 * scopes ever leave the service. `truncated` is true when any status row cap
 * was reached, so `byKind` is a lower bound for active records. `importance`
 * is absent when the older paged `record.list` fallback was used.
 */
export interface MemoryStats {
  readonly byKind: MemoryStatsByKind;
  readonly byStatus: MemoryStatsByStatus;
  readonly importance?: MemoryStatsImportance;
  /** Epoch ms when this snapshot was collected. */
  readonly computedAt: number;
  readonly truncated: boolean;
}

export interface MemoryService {
  /** Pre-answer recall hook for the agent (fail-open: never throws). */
  readonly recallHook: {
    readonly scope: string;
    recall(
      query: string,
      signal: AbortSignal,
      /**
       * Additive (I01-06): optional kernel status sink. When provided, the
       * hook reports the fixed CLI failure code (metadata only, closed set)
       * before resolving memoryless; success reports nothing.
       */
      onFailure?: (code: MemoryCliFailureCode) => void,
    ): Promise<ReadonlyArray<MemoryRecallItem>>;
  };
  /** Foreground activity: preempts an in-flight idle drain. */
  notifyForeground(): void;
  /**
  /** Post-settlement hook: only completed + currently-selected runs cultivate. */
  onRunCompleted(runId: string): void;
  start(): void;
  stop(): Promise<void>;
  /** Execute one bounded drain tick (startup recovery + tests). */
  drainOnce(): Promise<{ executed: number }>;
  /**
   * Explicit user-directed search over active+retired (archived/superseded
   * excluded by remind `record.search`). Persists an immutable per-handle
   * snapshot and returns opaque session-scoped `mN` handles, never raw
   * canonical ids. Search never heats, reactivates, or grants feedback:
   * explicit search/open/mere UI display never calls `record.feedback`.
   */
  searchMemories(input: {
    sessionId: string;
    runId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchResult>;
  /**
   * Read-only content statistics for the configured scope: active counts by
   * kind, counts by status, cached for five minutes (single-flight). Never
   * returns record bodies, ids, or scopes.
   */
  getMemoryStats(): Promise<MemoryStats>;
  /**
   * Confirmation detail for one bound handle: the immutable cited snapshot
   * (what the user/model saw) kept DISTINCT from the CURRENT
   * content/provenance/status re-read live via `record.get`. Never heats.
   */
  getMemoryDetail(input: {
    sessionId: string;
    searchId: string;
    handle: string;
  }): Promise<MemoryDetailResult>;
  /**
   * Global graph projection (`graph.version` + `graph.page`): bounded
   * paging (≤500 nodes), version-cached raw traversal, edges restricted to
   * returned nodes, and opaque handles minted into one durable graph search
   * per (session, scope). Read-only: never feedback/heat.
   */
  getMemoryGraphGlobal(
    sessionId: string,
    input: {
      includeRetired?: boolean;
      runId: string;
      signal?: AbortSignal;
    },
  ): Promise<MemoryGraphResult>;
  /**
   * Local graph projection (`graph.local`): `searchId`+`handle` resolve to
   * the exact historical snapshot record (session-bound, never rebound),
   * then depth 1|2 traversal is mapped to graph handles with `center` set.
   */
  getMemoryGraphLocal(
    sessionId: string,
    input: {
      searchId: string;
      handle: string;
      depth?: 1 | 2;
      runId: string;
      signal?: AbortSignal;
    },
  ): Promise<MemoryGraphResult>;
  /**
   * Stage one management mutation through the durable outbox (queued, never
   * applied here). Corrections chain a NEW raw source `event.append`
   * carrying the user's actual replacement, then a real `record.correct`
   * preserving old history (replay recovers the event first, never
   * duplicate revisions). Ambiguous targets stage NOTHING.
   */
  stageMemoryMutation(input: {
    sessionId: string;
    runId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    searchId: string;
    handle?: string;
    correctionBody?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    /**
     * Server-known caller origin. True ONLY for the trusted USER UI
     * selection path (HTTP route hardcodes it); the model tool path always
     * passes false (hardcoded in bootstrap, never read from model args).
     * A model-controlled flag must never set this.
     */
    trustedSelection?: boolean;
  }): Promise<MemoryStageOutcome>;
  /** Durable 202-ack operation status read (session-ownership enforced). */
  getMemoryOperation(
    sessionId: string,
    operationId: string,
  ): MemoryOperationStatus | null;
  /**
   * Per-run recall exposure for answer citations (`mN`): the exact snippet
   * the model saw during ONE run, or null when the citation is not bound
   * to that run's exposure in this session. I04: the pinned revision and
   * provenance kind are included (null = unknown/pre-I04).
   */
  getMemoryRecallExposure(input: {
    sessionId: string;
    runId: string;
    citation: string;
  }): {
    runId: string;
    citation: string;
    snippet: string;
    revision: number | null;
    kind: "user_fact" | "model_inference" | "summary" | "correction" | null;
  } | null;
  /**
   * Draining replay identity: recompute the immutable request hash for an
   * incoming same-key mutation without staging, or null when unverifiable.
   */
  hashDrainingReplay(input: {
    kind: "record.correct" | "record.retire" | "record.reactivate";
    sessionId: string;
    searchId: string;
    handle?: string;
    correctionBody?: string;
  }): { requestHash: string; recordId: string } | null;
}

/** One opaque search hit: handle + snippet + status (no raw ids). */
export interface MemorySearchHit {
  readonly handle: string;
  readonly snippet: string;
  readonly status: "active" | "retired";
  /** Record creation instant (canonical ISO), when remind returned it. */
  readonly createdAt?: string;
}

export interface MemorySearchResult {
  readonly searchId: string;
  readonly hits: readonly MemorySearchHit[];
}

export interface MemoryGraphEpisode {
  readonly kind: "session" | "doc" | "day";
  readonly episodeKey: string;
  readonly level: "window" | "episode";
}

/** One graph node with an opaque session-scoped handle (never a raw id). */
export interface MemoryGraphNodeResult {
  readonly handle: string;
  readonly label: string;
  readonly status: "active" | "retired";
  readonly kind: string;
  /** Derived general-category topics (≤3, each ≤12 cp); omitted when empty. */
  readonly topics?: readonly string[];
  /** Remind record creation instant (canonical ISO), when present. */
  readonly createdAt?: string;
  readonly episode: MemoryGraphEpisode | null;
}

export interface MemoryGraphEdgeResult {
  readonly from: string;
  readonly to: string;
  readonly kind: "related" | "consolidation" | "similar";
}

/** Raw remind graph node (record id is server-only, never serialized). */
interface RawGraphNode {
  id: string;
  label: string;
  status: "active" | "retired";
  kind: string;
  /** Canonical topics; empty when remind omits/returns nothing valid. */
  topics: string[];
  createdAt?: string;
  episode: MemoryGraphEpisode | null;
}

interface RawGraphEdge {
  from: string;
  to: string;
  kind: "related" | "consolidation" | "similar";
}

/**
 * Explicit graph projection. `searchId` is the durable `query='graph'`
 * snapshot holding the minted handles, so the existing detail/mutation
 * item routes resolve them without a new snapshot kind.
 */
export interface MemoryGraphResult {
  readonly searchId: string;
  /** Opaque remind `graph.version` token (string; never interpreted). */
  readonly version: string;
  readonly scope: "global" | "local";
  readonly center: string | null;
  readonly nodes: readonly MemoryGraphNodeResult[];
  readonly edges: readonly MemoryGraphEdgeResult[];
  readonly truncated: boolean;
}

/** Immutable cited snapshot kept distinct from the live current record. */
export interface MemoryDetailResult {
  readonly snapshot: MemorySearchHit & { readonly searchId: string };
  readonly current: {
    readonly body: string;
    readonly kind: string;
    readonly status: string;
    readonly revision: number;
    readonly source: string;
    readonly observedAt: string;
    readonly createdAt: string;
    /** Persisted verbatim quote (remind#41), or null when none. */
    readonly evidence?: string | null;
  };
  /** True when the live status moved since the snapshot was cited. */
  readonly stale: boolean;
}

export type MemoryStageOutcome =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly status: "pending" | "acked" | "failed";
      readonly deduplicated: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "needs_clarification"
        | "target_not_found"
        | "state_conflict"
        | "validation_error"
        | "service_unavailable"
        | "idempotency_conflict";
      readonly candidates?: readonly MemorySearchHit[];
    };

export interface MemoryOperationStatus {
  readonly operationId: string;
  readonly kind: "record.correct" | "record.retire" | "record.reactivate";
  readonly recordRevision: number | null;
  readonly status: "pending" | "acked" | "failed";
}

/** Fixed management failure (code only, never values). */
export class MemoryManageError extends Error {
  readonly code:
    | "needs_clarification"
    | "target_not_found"
    | "state_conflict"
    | "validation_error"
    | "service_unavailable"
    | "idempotency_conflict"
    | "memory_graph_unavailable";

  constructor(code: MemoryManageError["code"]) {
    super(code);
    this.name = "MemoryManageError";
    this.code = code;
  }
}

/** Fixed management cancellation (cooperative abort, preemption/shutdown). */
export class MemoryManageCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "MemoryManageCancelled";
  }
}

interface ExtractedMemory {
  readonly body: string;
  readonly kind: string;
  readonly sensitivity: MemoryPrivacySensitivity;
  /** Optional derived general-category topics (1..3, each 1..12 cp). */
  readonly topics?: readonly string[];
  /**
   * Optional persisted quote (remind#41) for grounded `user_fact` only:
   * the user's own words, NFC-normalized, trimmed, control-free, <= 400 cp.
   */
  readonly evidence?: string;
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

function sliceCodePoints(text: string, max: number): string {
  if (max < 0) {
    return "";
  }
  return Array.from(text).slice(0, max).join("");
}

/**
 * Fail-safe provenance resolution for extracted items. `user_fact` is
 * accepted ONLY when the model supplied a bounded verbatim `evidence`
 * quote that is a substring of the user's own turn text (after grounding
 * normalization; see extraction_grounding.ts). Missing/invalid/ungrounded
 * evidence DOWNGRADES the item to `model_inference` — the memory is kept,
 * never silently dropped, and never presented as something the user stated.
 * Without turn text (legacy direct parser callers) no grounding verdict is
 * possible; the caller must supply the user turn for production extraction.
 */
function resolveExtractedKind(
  kind: string,
  evidence: string | undefined,
  userText: string | null | undefined,
): string {
  if (kind !== "user_fact" || typeof userText !== "string") {
    return kind;
  }
  if (evidence === undefined) {
    return "model_inference";
  }
  return isGroundedExtractionQuote(evidence, userText)
    ? "user_fact"
    : "model_inference";
}

/**
 * Stable v4-shaped UUID for one logical outbox write, derived from
 * SHA-256 over a domain-separated key. Passes `isUuidV4` (version and
 * variant nibbles forced) and the remind key charset, so the SAME logical
 * write always reuses the SAME outbox + CLI idempotency key across crash
 * replays and follow-up re-enqueues: never a duplicate write.
 */
export function stableMemoryJobKey(...parts: Array<string | number>): string {
  const digest = createHash("sha256")
    .update(`memory-job:${parts.join(":")}`)
    .digest("hex");
  const chars = digest.split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16] as string, 16) & 0x3;
  chars[16] = (["8", "9", "a", "b"] as const)[variant] ?? "8";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function hasControlCode(text: string): boolean {
  for (const unit of text) {
    const code = unit.codePointAt(0) ?? 0;
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a model-grounded user quote for remind#41 persistence:
 * unescape the extraction delimiters (the model sees entity-escaped turn
 * text), NFC-normalize (remind's contract; never NFKC/casefold), replace
 * control characters with spaces, trim, and cap at
 * MEMORY_EVIDENCE_MAX_CP code points. Returns null when nothing is left
 * (the caller then omits `evidence` rather than sending an invalid value).
 * The value is only ever attached to an already-grounded `user_fact`.
 */
export function normalizeStoredEvidence(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = unescapeExtractionDelimiters(raw).normalize("NFC");
  let cleaned = "";
  for (const unit of normalized) {
    const code = unit.codePointAt(0) ?? 0;
    cleaned +=
      (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
        ? " "
        : unit;
  }
  const trimmed = cleaned.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const capped = sliceCodePoints(trimmed, MEMORY_EVIDENCE_MAX_CP).trim();
  return capped.length > 0 ? capped : null;
}

/**
 * Validate an `evidence` value already stored by remind (recall/detail):
 * a string of 1..MEMORY_EVIDENCE_MAX_CP code points without control
 * characters. `null`, absent, and invalid values are omitted (never a
 * fabricated quote).
 */
export function normalizeRecalledEvidence(raw: unknown): string | null {
  if (typeof raw !== "string" || hasControlCode(raw)) {
    return null;
  }
  const trimmed = raw.normalize("NFC").trim();
  const size = countCodePoints(trimmed);
  if (size < 1 || size > MEMORY_EVIDENCE_MAX_CP) {
    return null;
  }
  return trimmed;
}

/**
 * Canonicalize ONE topic (remind PR #29 `canonicalizeTopic` shape): NFKC,
 * trim surrounding whitespace, 1..12 code points, no control characters.
 * Returns null for anything invalid (the caller drops only that topic).
 */
export function canonicalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.normalize("NFKC").trim();
  const size = countCodePoints(trimmed);
  if (size < 1 || size > MEMORY_TOPIC_MAX_CP || hasControlCode(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Strict topic-list normalization: every entry must canonicalize; dedupe by
 * case-insensitive canonical form; at most MEMORY_TOPIC_MAX entries. An
 * invalid/absent list yields [] (never throws, so a bad topics field can
 * never drop the memory itself).
 */
export function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (out.length >= MEMORY_TOPIC_MAX) {
      break;
    }
    const topic = canonicalizeTopic(value);
    if (topic === null) {
      continue;
    }
    const key = topic.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(topic);
  }
  return out;
}

/**
 * Strip exactly ONE surrounding markdown code fence (``` or ```json) plus
 * surrounding whitespace. This is NOT a free-text fallback: the content
 * inside must still be a single strict-JSON object accepted by
 * `parseExtractionOutput`. Anything that is not one fence-wrapped payload
 * (leading prose, multiple fences, trailing text after the closing fence)
 * is returned as the trimmed input and rejected by the strict parser.
 */
export function stripOneJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  let inner = trimmed.slice(3);
  const close = inner.lastIndexOf("```");
  if (close !== -1) {
    inner = inner.slice(0, close);
  }
  const newlineIdx = inner.indexOf("\n");
  if (newlineIdx === -1) {
    // No body line: either a bare language tag or raw JSON glued to the
    // fence. Only a plain language tag ("json") is strip-able; otherwise
    // hand the raw text to the strict parser unchanged.
    return /^[A-Za-z0-9_-]+$/.test(inner.trim())
      ? inner.trim()
      : trimmed
          .slice(3)
          .trim()
          .replace(/^json\b/, "")
          .trim();
  }
  const firstLine = inner.slice(0, newlineIdx).trim();
  if (firstLine !== "" && !/^[A-Za-z0-9_-]+$/.test(firstLine)) {
    // The first line is JSON content, not a language tag: keep it.
    return inner.trim();
  }
  return inner.slice(newlineIdx + 1).trim();
}

export type ExtractionParseStatus = "ok" | "none" | "invalid" | "aborted";

export interface ExtractionParseResult {
  readonly items: ExtractedMemory[];
  /**
   * "ok": at least one valid memory parsed. "none": valid strict-JSON
   * `{memories: []}` shape with zero items (genuine nothing-to-remember).
   * "invalid": unparseable, wrong shape, or items present but ALL rejected
   * (model output shape problem — never conflated with a valid empty).
   * "aborted": OUR OWN call was aborted (foreground preemption, its own
   * `timeoutMs` bound, or shutdown) — never a payload verdict; the caller
   * lands NO memory write for the run (no late writes after STOP).
   */
  readonly status: ExtractionParseStatus;
}

/**
 * Strict extraction-output validation: exact `{ memories: [...] }` shape,
 * at most MEMORY_EXTRACT_MAX_ITEMS items. Each item must carry exactly
 * `{ body, kind }` plus optional `sensitivity` (F-I01-05 P5), `topics`
 * (remind#29), and `evidence` (speaker grounding): no other keys are
 * allowed. Body/kind stay strict (invalid drops the item); a
 * missing/invalid/undecidable sensitivity fails closed to `sensitive`
 * (the item is kept, never upgraded to `normal`). `evidence` is optional for
 * `summary`/`model_inference`; for `user_fact` it must be a bounded verbatim
 * quote from the supplied `userText`, otherwise the item is downgraded to
 * `model_inference` (kept, never dropped). A grounded user_fact keeps the
 * normalized (NFC/trim, control-free, <= 400 code points) quote as
 * `evidence` for remind#41; downgraded items never carry it.
 * Zero valid items yields no memory.
 *
 * `userText` is the user's own turn. Production extraction always passes it;
 * omitting it (legacy direct parser calls) skips grounding because there is
 * no user turn to verify against.
 */
export function parseExtractionOutput(
  text: string,
  userText?: string | null,
): ExtractedMemory[] {
  return parseExtractionOutcome(text, userText).items;
}

/** Strict parse plus tri-state outcome (ok / valid-empty / invalid). */
export function parseExtractionOutcome(
  text: string,
  userText?: string | null,
): ExtractionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripOneJsonFence(text));
  } catch {
    return { items: [], status: "invalid" };
  }
  if (!isRecord(parsed)) {
    return { items: [], status: "invalid" };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "memories") {
    return { items: [], status: "invalid" };
  }
  const list = parsed.memories;
  if (!Array.isArray(list)) {
    return { items: [], status: "invalid" };
  }
  const out: ExtractedMemory[] = [];
  for (const item of list.slice(0, MEMORY_EXTRACT_MAX_ITEMS)) {
    if (!isRecord(item)) {
      continue;
    }
    const itemKeys = Object.keys(item);
    const hasBody = itemKeys.includes("body");
    const hasKind = itemKeys.includes("kind");
    const hasSensitivity = itemKeys.includes("sensitivity");
    const hasTopics = itemKeys.includes("topics");
    const hasEvidence = itemKeys.includes("evidence");
    if (!hasBody || !hasKind) {
      continue;
    }
    // Exact-key discipline: only body/kind plus additive sensitivity,
    // topics (remind PR #29), and evidence (speaker grounding). Unknown
    // keys still reject the whole item.
    if (
      itemKeys.length !==
        2 +
          (hasSensitivity ? 1 : 0) +
          (hasTopics ? 1 : 0) +
          (hasEvidence ? 1 : 0) ||
      itemKeys.some(
        (key) =>
          key !== "body" &&
          key !== "kind" &&
          key !== "sensitivity" &&
          key !== "topics" &&
          key !== "evidence",
      )
    ) {
      continue;
    }
    const { body, kind, sensitivity, topics, evidence } = item as {
      body?: unknown;
      kind?: unknown;
      sensitivity?: unknown;
      topics?: unknown;
      evidence?: unknown;
    };
    if (
      typeof body !== "string" ||
      typeof kind !== "string" ||
      !EXTRACT_KINDS.has(kind)
    ) {
      continue;
    }
    const resolvedSensitivity: MemoryPrivacySensitivity =
      typeof sensitivity === "string" && EXTRACT_SENSITIVITIES.has(sensitivity)
        ? (sensitivity as MemoryPrivacySensitivity)
        : "sensitive";
    const size = countCodePoints(body);
    if (size < 1 || size > MEMORY_EXTRACT_BODY_MAX_CP) {
      continue;
    }
    let clean = true;
    for (const unit of body) {
      const code = unit.codePointAt(0) ?? 0;
      if (
        (code >= 0x00 && code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
        (code >= 0x7f && code <= 0x9f)
      ) {
        clean = false;
        break;
      }
    }
    if (!clean) {
      continue;
    }
    // Topics are additive and fail-open PER FIELD: an invalid list is
    // dropped while the memory itself is kept (never rejected).
    const validTopics = normalizeTopics(topics);
    // Evidence validates the speaker first: a bounded non-empty string can
    // ground a user_fact; anything else is treated as absent, which
    // downgrades user_fact to model_inference via `resolveExtractedKind`.
    // Only the grounded kind keeps the (normalized, 400-cp) quote.
    const evidenceText: string | undefined =
      typeof evidence === "string" &&
      countCodePoints(evidence) >= 1 &&
      countCodePoints(evidence) <= MEMORY_EXTRACT_EVIDENCE_MAX_CP
        ? evidence
        : undefined;
    const resolvedKind = resolveExtractedKind(kind, evidenceText, userText);
    // Persist the quote ONLY when the item is still a grounded user_fact.
    // A downgraded item never carries evidence (it is model inference), and
    // the stored value is normalized/truncated to remind#41's contract.
    const storedEvidence =
      resolvedKind === "user_fact" && typeof userText === "string"
        ? normalizeStoredEvidence(evidenceText)
        : null;
    out.push({
      body,
      kind: resolvedKind,
      sensitivity: resolvedSensitivity,
      ...(validTopics.length > 0 ? { topics: validTopics } : {}),
      ...(storedEvidence !== null ? { evidence: storedEvidence } : {}),
    });
  }
  // Tri-state outcome: raw items were present but every one was rejected —
  // an output-shape problem, never a valid "nothing to remember".
  // Store-everything decision (2026-10-20): when ANY valid items parsed,
  // the output MUST also carry at least one `summary` item (the
  // per-turn digest the raw event is recallable through). Valid items
  // missing that summary are an output-shape problem -> invalid.
  if (out.length > 0 && !out.some((item) => item.kind === "summary")) {
    return { items: [], status: "invalid" };
  }
  return {
    items: out,
    status: out.length > 0 ? "ok" : list.length > 0 ? "invalid" : "none",
  };
}

/**
 * Validate recall response data: closed shape, bounded items. Exported for
 * contract tests (F-I01-04): callers always go through the recall hook.
 */
export interface ParsedRecallItem {
  id: string;
  snippet: string;
  /** Provenance kind, or undefined when absent or an unknown value. */
  kind?: MemoryRecallItemKind;
  /** Positive safe-integer revision, or undefined when absent/invalid. */
  revision?: number;
  /** Record creation instant, or undefined when absent/invalid. */
  createdAt?: string;
  /** Persisted verbatim quote for a user_fact (remind#41), when present. */
  evidence?: string;
}

/**
 * Validate recall response data: closed shape, bounded items. Additive
 * item fields (`kind`, `revision` from remind#16) are read tolerantly:
 * absent fields are allowed, a kind outside the closed set (including a
 * missing field) becomes an unknown kind, and a non-positive-safe-integer
 * revision is treated as absent (F-I01-01, F-I01-04). The top-level
 * `vector` mode (disabled/used/unavailable) is metadata only and likewise
 * treated as absent when invalid (F-I01-05). Everything else keeps the
 * strict shape. Grant pinning prefers this recall `revision` (exposure
 * carries it; grants copy the exposure) with the existing unknown fallback.
 */
export function parseRecallData(data: Record<string, unknown> | null): {
  recallId: string;
  items: ParsedRecallItem[];
  vector?: MemoryRecallVector;
} | null {
  if (data === null || typeof data.recallId !== "string") {
    return null;
  }
  const recallId = data.recallId;
  if (
    recallId.length < 1 ||
    recallId.length > 256 ||
    hasControlCode(recallId)
  ) {
    return null;
  }
  const rawItems = data.items;
  if (!Array.isArray(rawItems)) {
    return null;
  }
  const items: ParsedRecallItem[] = [];
  for (const item of rawItems.slice(0, 8)) {
    if (!isRecord(item)) {
      continue;
    }
    const { id, snippet, kind, revision, createdAt, evidence } = item as {
      id?: unknown;
      snippet?: unknown;
      kind?: unknown;
      revision?: unknown;
      createdAt?: unknown;
      evidence?: unknown;
    };
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 256 ||
      typeof snippet !== "string" ||
      snippet.length < 1 ||
      countCodePoints(snippet) > 512
    ) {
      continue;
    }
    // Additive provenance fields (F-I01-04/F-I04-07, remind#16): the
    // closed recall kind set is carried (`correction` included, mapped to
    // itself and stored as such); any other value (including a missing
    // field) stays unknown and is never presented as a user fact (kernel
    // inference framing covers model_inference/summary/correction plus
    // unknown). Revision must be
    // a positive safe integer; absent/invalid means unknown revision
    // (grant keeps the existing exposure-copy fallback, preferring the
    // recall revision when available).
    const itemKind: MemoryRecallItemKind | undefined =
      typeof kind === "string" && RECALL_KINDS.has(kind)
        ? (kind as MemoryRecallItemKind)
        : undefined;
    const itemRevision: number | undefined =
      typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      revision > 0
        ? revision
        : undefined;
    // Additive createdAt: only a strict canonical ISO instant is carried;
    // anything else (absent, offset form, invalid) is omitted.
    const itemCreatedAt: string | undefined = isCanonicalIsoInstant(createdAt)
      ? createdAt
      : undefined;
    // Additive (remind#41): a bounded verbatim quote on user_fact items.
    // `null`, absent, over-limit, or control-bearing values are omitted;
    // a quote on any other kind is never surfaced as the user's words.
    const itemEvidence =
      itemKind === "user_fact" ? normalizeRecalledEvidence(evidence) : null;
    items.push({
      id,
      snippet,
      ...(itemKind !== undefined ? { kind: itemKind } : {}),
      ...(itemRevision !== undefined ? { revision: itemRevision } : {}),
      ...(itemCreatedAt !== undefined ? { createdAt: itemCreatedAt } : {}),
      ...(itemEvidence !== null ? { evidence: itemEvidence } : {}),
    });
  }
  const rawVector: unknown = (data as Record<string, unknown>).vector;
  const vector: MemoryRecallVector | undefined =
    typeof rawVector === "string" && RECALL_VECTORS.has(rawVector)
      ? (rawVector as MemoryRecallVector)
      : undefined;
  return {
    recallId,
    items,
    ...(vector !== undefined ? { vector } : {}),
  };
}

export function createMemoryService(
  options: MemoryServiceOptions,
): MemoryService {
  const { address, scope, recallLimit, idleMs, repo, gateway, model } = options;
  /**
   * Whether `record.remember` may carry the remind#41 `evidence` quote.
   * Starts from config, and latches to false for the rest of the process
   * when an older remind rejects the key with BAD_REQUEST (see
   * `executeJob`): no per-remember error storm, and every user fact still
   * persists without the quote.
   */
  let sendEvidence = options.sendEvidence !== false;
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const cliCall = options.cliCall ?? callMemoryCli;
  const distillTimeoutMs =
    options.distillTimeoutMs ?? MEMORY_DISTILL_TIMEOUT_MS;
  const extractTimeoutMs = Math.min(
    Math.max(
      options.extractTimeoutMs ?? MEMORY_EXTRACT_TIMEOUT_MS,
      MIN_MEMORY_EXTRACT_TIMEOUT_MS,
    ),
    MAX_MEMORY_EXTRACT_TIMEOUT_MS,
  );
  const graphPageLimit = Math.min(
    Math.max(
      Math.trunc(options.graphPageLimit ?? MEMORY_GRAPH_PAGE_LIMIT_DEFAULT),
      1,
    ),
    MEMORY_GRAPH_NODE_MAX,
  );
  /**
   * Configured IANA zone (COMPANION_TIME_ZONE): the extraction fallback
   * when the Turn carries no frozen temporal.
   */
  const timeZone = options.timeZone ?? "UTC";
  /**
   * In-process global graph cache keyed by (memory scope, includeRetired).
   * The cached raw traversal is reused only when `graph.version` matches;
   * handles are re-minted (reused) from the durable search on every read.
   */
  const graphCache = new Map<
    string,
    {
      version: string;
      nodes: RawGraphNode[];
      edges: RawGraphEdge[];
      truncated: boolean;
    }
  >();

  let started = false;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let drainInFlight: Promise<{ executed: number }> | null = null;
  /**
   * Every active drain tick owns a controller (startup recovery,
   * foreground completion, AND idle distill): stop() aborts all of them so
   * no CLI child outlives shutdown, however the tick was launched.
   */
  const drainControllers = new Set<AbortController>();
  /**
   * Controllers for in-flight AUTOMATIC model-heavy CLI calls only
   * (`maintain.distill`, the one outbox op that launches the remind local
   * LLM): foreground activity and STOP abort exactly these — never an
   * explicit user-authorized manage/foreground-recall call. Each entry is
   * a per-job controller (scoped to one `executeJob`), so aborting it ends
   * only that CLI child; the tick continues with explicit jobs. Released
   * only after the guarded call settles (no late-child overlap).
   */
  const backgroundJobControllers = new Set<AbortController>();
  /** Outbox kind for automatic cultivation (the only local-LLM job). */
  const AUTOMATIC_DISTILL_KIND = "maintain.distill";
  /**
   * Every in-flight post-completion extraction owns a controller here (its
   * OWN gateway call only, never the global gateway): foreground activity
   * and STOP/shutdown abort it so a parked extraction socket cannot outlive
   * the state that requested it. Late provider output after an abort is
   * discarded (never enqueued).
   */
  const extractionControllers = new Set<AbortController>();
  /**
   * Foreground-preempted extraction retries (`runId` -> attempts so far).
   * A preempted preemption stays PENDING here until the next idle window
   * re-cultivates the run via the SAME authoritative path; STOP/shutdown
   * aborts and exhausted attempts drop out. In-process state only.
   */
  const extractionRetryAttempts = new Map<string, number>();
  /** Shared background admission (null = legacy ungated behavior). */
  const background = options.background ?? null;
  /** True while the in-flight tick belongs to idle distill (preemptible). */
  let idleDrainActive = false;
  /** Last completed run anchoring run-agnostic idle distill (real ids only). */
  let lastCompletedRun: {
    sessionId: string;
    runId: string;
    turnId: string;
  } | null = null;
  /** In-process pending distill job id (never duplicated while pending). */
  let pendingDistillJobId: string | null = null;
  /**
   * Derived association maintenance (remind PR #29). `associateDirty`
   * starts true so one idle tick associates the existing store, then is
   * re-armed when a remember jobs was enqueued and stays armed while the
   * last `maintain.associate` reported `remaining > 0`. The two latches
   * remember an old remind that answered BAD_REQUEST: no retry until a
   * restart, never a per-tick error storm.
   */
  let associateDirty = true;
  let associateUnsupported = false;
  let topicsUnsupported = false;
  /**
   * Derived consolidation + activation maintenance (remind >=795c476).
   * `consolidateDirty` arms after an association pass wrote topics/edges
   * and after a remember was enqueued, and stays armed only while the last
   * `maintain.consolidate` applied a real write (`applied > 0`). Deferred/
   * no_grounded clusters wait for the next remember/association re-arm,
   * never a per-tick retry loop. `activationDirty` arms after a remember/
   * consolidation and is consumed at most ONCE per idle pass (small
   * preview page). The `*Unsupported` latches mirror the associate one: a
   * BAD_REQUEST or LIMIT_EXCEEDED answer is never retried until a restart
   * (no per-tick error storm).
   */
  let consolidateDirty = false;
  let consolidateUnsupported = false;
  let activationDirty = false;
  let activationUnsupported = false;
  /**
   * Foreground preemption epoch: `notifyForeground()` bumps it, and an
   * in-flight idle-maintenance pass compares the value it captured at
   * start. A preemption therefore cancels the WHOLE pass (topic loop and
   * association), not just the one in-flight model call.
   */
  let foregroundEpoch = 0;
  /** In-flight idle-maintenance CLI calls (aborted by preemption/stop). */
  const idleMaintenanceControllers = new Set<AbortController>();
  /** In-flight idle-maintenance batch: stop() awaits it (no orphan child). */
  let idleMaintenanceInFlight: Promise<void> | null = null;
  /** In-flight explicit staging count: stop() waits for zero (no post-stop writes). */
  let pendingStagings = 0;
  /** Five-minute stats snapshot and single-flight collection promise. */
  let statsCache: { readonly at: number; readonly value: MemoryStats } | null =
    null;
  let statsPending: Promise<MemoryStats> | null = null;
  /** Remind's accepted `record.list` page size (downgraded on rejection). */
  let statsPageLimitIndex = 0;
  /** Latched after remind answers BAD_REQUEST for the `record.stats` op. */
  let statsUnsupported = false;

  function throwIfStagingCancelled(signal?: AbortSignal): void {
    if (isAborted(signal)) {
      throw new MemoryManageCancelled();
    }
    if (stopped) {
      throw new MemoryManageCancelled();
    }
  }

  /**
   * Every in-flight graph projection read owns a controller here. stop()
   * aborts these CLI children and awaits their settlement, so a shutdown
   * during `graph.version`/`graph.page`/`graph.local` can neither keep
   * paging nor mint handles (write a projection) against a closed DB.
   */
  const graphReads = new Set<{
    readonly controller: AbortController;
    readonly settled: Promise<void>;
  }>();

  /**
   * Run one graph read under shutdown tracking. The caller signal (HTTP
   * client disconnect) is forwarded to a service-owned controller, so
   * `stop()` can abort the same call; after the awaited read the projection
   * write is fenced by `stopped`/abort (no post-shutdown mint or cache).
   */
  async function trackGraphRead<T>(
    external: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    throwIfStagingCancelled(external);
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry = { controller, settled };
    graphReads.add(entry);
    const forwardAbort = (): void => controller.abort();
    if (external !== undefined) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener("abort", forwardAbort, { once: true });
      }
    }
    try {
      const result = await read(controller.signal);
      // Fence the projection write: a stop/abort during the awaited read
      // must not mint handles after shutdown started.
      throwIfStagingCancelled(controller.signal);
      return result;
    } finally {
      if (external !== undefined) {
        external.removeEventListener("abort", forwardAbort);
      }
      graphReads.delete(entry);
      settle();
    }
  }

  const log = (
    level: "info" | "warn" | "error",
    code: string,
    fields?: {
      runId?: string;
      bytes?: number;
      durationMs?: number;
      attempt?: number;
      status?: number | string;
    },
  ): void => {
    try {
      logger?.[level](code, fields);
    } catch {
      // Logging never fails memory work.
    }
  };

  /** Fixed failure code for the activity table (never a raw CLI message). */
  function maintenanceErrorCode(
    code: string | null | undefined,
    aborted = false,
  ): string {
    if (aborted) {
      return "preempted";
    }
    switch (code) {
      case "TIMEOUT":
      case "cli_timeout":
        return "timeout";
      case "BAD_REQUEST":
      case "cli_bad_request":
        return "bad_request";
      case "LIMIT_EXCEEDED":
      case "cli_limit":
        return "limit_exceeded";
      case "STORE_UNAVAILABLE":
        return "store_unavailable";
      case "FORBIDDEN_SCOPE":
        return "forbidden_scope";
      case "NOT_FOUND":
        return "not_found";
      case "CONFLICT":
        return "conflict";
      default:
        return "cli_failed";
    }
  }

  /**
   * Persist one maintenance pass for the read-only browser view. Counts are
   * the SAME fixed numeric summaries already logged; a bookkeeping failure
   * never affects memory work.
   */
  function recordMaintenanceRun(input: {
    op: MemoryMaintenanceOp;
    startedAt: number;
    ok: boolean;
    errorCode?: string | null;
    counts?: Record<string, number>;
  }): void {
    try {
      repo.insertMemoryMaintenanceRun({
        op: input.op,
        scope,
        startedAt: input.startedAt,
        finishedAt: now(),
        ok: input.ok,
        ...(input.ok ? {} : { errorCode: input.errorCode ?? "cli_failed" }),
        counts: input.counts ?? {},
      });
    } catch {
      log("warn", "memory.activity.record_failed");
    }
  }

  function armIdleTimer(): void {
    if (!started || stopped) {
      return;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined;
        void runIdleDistill().catch(() => undefined);
      },
      Math.max(idleMs, 1),
    );
    if (
      idleTimer !== undefined &&
      typeof (idleTimer as unknown as { unref?: unknown }).unref === "function"
    ) {
      (idleTimer as unknown as { unref(): void }).unref();
    }
  }

  function notifyForeground(): void {
    // Foreground preemption: abort OUR OWN parked extraction call plus any
    // in-flight AUTOMATIC distill CLI child (tracked background controllers
    // only, whatever tick launched them — idle, completion, or recovery).
    // Explicit user-authorized manage calls and foreground recall are NEVER
    // aborted here: only extractionControllers (our own gateway call) plus
    // background-owned distill children. The tick itself keeps running so
    // explicit jobs still complete.
    //
    // Legacy ungated services (background null) track no background
    // controllers: preserve the previous whole-idle-tick preemption so a
    // parked automatic child cannot outlive foreground activity there.
    foregroundEpoch += 1;
    if (background === null && idleDrainActive) {
      for (const controller of [...drainControllers]) {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      }
    }
    for (const controller of [...extractionControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    // Idle maintenance CLI/model calls are autonomous background work too:
    // foreground activity preempts them (they are retried on a later tick).
    for (const controller of [...idleMaintenanceControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    for (const controller of [...backgroundJobControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    armIdleTimer();
  }

  /**
   * Autonomy pause deliberately does NOT touch this service (I03-09):
   * memory writes (`event.append`, `record.remember`, feedback) and
   * cultivation (idle `maintain.distill`) are autonomous, no-approval work
   * that keeps running while autonomy is PAUSED — pause gates only
   * autonomous work (tasks/shadow/proposals). The shared background gate's
   * `closed` flag is therefore owned by shutdown only: while closed
   * (shutdown/drain), extraction and automatic distill skip with the
   * honest `*_skipped_closed` diagnostics and durable pending jobs; the
   * foreground paths (recall/search/stage) never consult the gate.
   */

  /**
   * Execute one outbox job via the CLI. Returns true when the job reached a
   * durable disposition for this tick (acked, or failed-terminally), false
   * when it stays pending for a later tick (transient: bounded backoff).
   */
  async function executeJob(
    job: { id: string; kind: string; requestJson: string; attempts: number },
    signal?: AbortSignal,
  ): Promise<boolean> {
    let request: unknown;
    try {
      request = JSON.parse(job.requestJson);
    } catch {
      try {
        // Atomic: terminal job failure mirrors into any bound operation, so
        // operation polling ends `failed`, never indefinite `pending`.
        repo.failMemoryJobWithOperationMirror(job.id, "bad_request", {
          maxAttempts: 1,
          now: now(),
        });
      } catch {
        // Best effort.
      }
      return true;
    }
    if (
      !isRecord(request) ||
      typeof request.op !== "string" ||
      !isRecord(request.params)
    ) {
      try {
        repo.failMemoryJobWithOperationMirror(job.id, "bad_request", {
          maxAttempts: 1,
          now: now(),
        });
      } catch {
        // Best effort.
      }
      return true;
    }
    const op = request.op;
    const params = request.params as Record<string, unknown>;
    const isDistill = op === "maintain.distill";
    // The outbox row's stable key IS the CLI key (crash-replay stability).
    let rowKey: string;
    try {
      const row = repo.getMemoryJob(job.id);
      if (row === null) {
        return true;
      }
      rowKey = row.idempotencyKey;
    } catch {
      return false;
    }
    const startedAt = now();
    const callOptions = {
      ...(op === "maintain.distill" || op === "maintain.associate"
        ? { timeoutMs: distillTimeoutMs }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    // Once an older remind has rejected `evidence` (BAD_REQUEST), every
    // queued remember also drops it before spawn: the latch is process-wide,
    // not just for newly enqueued jobs.
    const withoutEvidence = (value: Record<string, unknown>) => {
      const { evidence: _omitted, ...rest } = value;
      return rest;
    };
    const mayCarryEvidence =
      op === "record.remember" &&
      sendEvidence &&
      Object.hasOwn(params, "evidence");
    const effectiveParams =
      op === "record.remember" && !sendEvidence && "evidence" in params
        ? withoutEvidence(params)
        : params;
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        op,
        effectiveParams,
        op === "record.recall" ? undefined : rowKey,
        callOptions,
      );
      // Older remind (pre-#41) strict params reject the unknown `evidence`
      // key with BAD_REQUEST. Retry ONCE without the quote under the same
      // stable idempotency key (a rejected call wrote nothing); only a
      // successful retry proves the key was the cause, so only then latch.
      // The fixed code is logged once (the latch makes this branch run once).
      if (mayCarryEvidence && !envelope.ok && envelope.code === "BAD_REQUEST") {
        envelope = await cliCall(
          address,
          op,
          withoutEvidence(effectiveParams),
          rowKey,
          callOptions,
        );
        if (envelope.ok) {
          sendEvidence = false;
          log("warn", "memory.evidence_unsupported");
        }
      }
    } catch (error) {
      // Aborted by foreground preemption/shutdown: NOT a failure, NOT an
      // attempt worth counting twice — bounded backoff rearm, still pending.
      if (isAborted(signal)) {
        if (isDistill) {
          recordMaintenanceRun({
            op: "maintain.distill",
            startedAt,
            ok: false,
            errorCode: "preempted",
            counts: {},
          });
        }
        try {
          // Atomic mirror path (consistent with every other drain outcome):
          // a non-terminal rearm touches no operation row, so answer-citation
          // polling stays `pending` instead of stranding on a half-write.
          repo.failMemoryJobWithOperationMirror(job.id, "cli_preempted", {
            maxAttempts: MEMORY_JOB_MAX_ATTEMPTS,
            now: now(),
          });
        } catch {
          // Best effort.
        }
        return false;
      }
      if (isDistill) {
        recordMaintenanceRun({
          op: "maintain.distill",
          startedAt,
          ok: false,
          errorCode:
            error instanceof MemoryCliError
              ? maintenanceErrorCode(error.cliCode)
              : "cli_unavailable",
          counts: {},
        });
      }
      const failure =
        error instanceof MemoryCliError ? error.cliCode : "cli_unavailable";
      // Transport/timeout/malformed CLI answers are transient: bounded
      // backoff rearm, never infinite. `cli_limit`/`cli_bad_request` are
      // caller bugs: terminal after the same cap instead of looping forever.
      const terminal = failure === "cli_limit" || failure === "cli_bad_request";
      try {
        // Atomic mirror: an exhausted transient (8 attempts) or a terminal
        // caller bug flips BOTH the job and any bound operation (source or
        // final mutation) to `failed` together — never pending forever.
        const outcome = repo.failMemoryJobWithOperationMirror(job.id, failure, {
          maxAttempts: terminal ? 1 : MEMORY_JOB_MAX_ATTEMPTS,
          now: now(),
        });
        void outcome;
      } catch {
        // Best effort: the next drain tick retries the claim.
      }
      log("warn", "memory.job_transient", {
        durationMs: Math.max(now() - startedAt, 0),
        attempt: job.attempts + 1,
      });
      return terminal;
    }
    const durationMs = Math.max(now() - startedAt, 0);
    if (envelope.ok) {
      // Chain follow-ups BEFORE the source ack lands, atomically: a
      // correction-event ack fans out to its single real `record.correct`
      // plus the operation rebind in ONE transaction. Any follow-up failure
      // propagates (no ack): the next tick replays the event under the same
      // stable key (remind dedups) and recovers the follow-up. A swallowed
      // failure here would ack the source while the chain is lost.
      try {
        enqueueManagementFollowUps(request);
      } catch {
        // Follow-up not durable: keep the source pending for retry.
        return false;
      }
      try {
        // Atomic ack + operation mirror in ONE transaction: the job and any
        // operation row still bound to it flip to `acked` together, so a
        // crash can never leave an acked job with a permanently `pending`
        // operation (pollers read the operation row). Rows already rebound
        // to a follow-up job (correction event -> real `record.correct`)
        // are untouched: the operation flips only when its real
        // correct/retire/reactivate job acks. Likewise a terminal `failed`
        // operation is never overwritten back to `acked`.
        repo.ackMemoryJobWithOperationMirror(job.id, { now: now() });
        if (pendingDistillJobId === job.id) {
          pendingDistillJobId = null;
        }
      } catch {
        // Ack failure keeps the job pending: the next tick replays with
        // the same stable key (remind dedups, no duplicate).
        return false;
      }
      if (isDistill) {
        recordMaintenanceRun({
          op: "maintain.distill",
          startedAt,
          ok: true,
          counts:
            isRecord(envelope.data) && envelope.data.degraded === true
              ? { degraded: 1 }
              : {},
        });
      }
      log("info", "memory.job_acked", { durationMs });
      return true;
    }
    // Domain rejections: same-key conflicts, BAD_REQUEST, FORBIDDEN_SCOPE,
    // NOT_FOUND, LIMIT_EXCEEDED fail terminally (bounded, no retry storm).
    // TIMEOUT/STORE_UNAVAILABLE are transient: bounded backoff rearm.
    const transient =
      envelope.code === "TIMEOUT" || envelope.code === "STORE_UNAVAILABLE";
    try {
      // Atomic mirror: terminal domain rejections (CONFLICT from a lost
      // correction race, NOT_FOUND, scope mismatch) fail the staged
      // operation together with the job — never silently retried into a
      // different revision. Exhausted transients flip together too. The UI
      // must refresh from a new explicit search, not guess a retry.
      repo.failMemoryJobWithOperationMirror(job.id, "cli_rejected", {
        maxAttempts: transient ? MEMORY_JOB_MAX_ATTEMPTS : 1,
        now: now(),
      });
      if (pendingDistillJobId === job.id && !transient) {
        pendingDistillJobId = null;
      }
    } catch {
      // Best effort.
    }
    if (isDistill) {
      recordMaintenanceRun({
        op: "maintain.distill",
        startedAt,
        ok: false,
        errorCode: maintenanceErrorCode(envelope.code),
        counts: {},
      });
    }
    log("warn", "memory.job_rejected", { durationMs });
    return !transient;
  }

  /**
   * Durable chain follow-ups, enqueued BEFORE the event ack lands (same
   * tick): an acked event.append fans out to its remember jobs AND to its
   * single correction job when the event is a NEW raw correction source.
   * Stable keys make crash replays dedup instead of duplicating: an
   * append-unknown-outcome replay recovers the event first and the correct
   * second, never minting duplicate revisions. THROWS when the correction
   * follow-up cannot be made durable so the caller keeps the source pending
   * (never acks a source whose chain is lost); remember fan-out stays
   * best-effort per item.
   */
  function enqueueManagementFollowUps(request: Record<string, unknown>): void {
    if (request.op !== "event.append") {
      return;
    }
    const chain = request.chain;
    if (!isRecord(chain)) {
      return;
    }
    enqueueRememberChainMemories(request, chain);
    // Throwing: a lost correction follow-up must block the source ack.
    enqueueCorrectChainCorrection(request, chain);
  }

  /**
   * Durable chain follow-up, enqueued BEFORE the event ack lands (same
   * tick): an acked event.append fans out to its remember jobs. Stable keys
   * make crash replays dedup instead of duplicating.
   */
  function enqueueRememberChainMemories(
    request: Record<string, unknown>,
    chain: Record<string, unknown>,
  ): void {
    const { eventId, sessionId, runId, turnId, provenance, memories } =
      chain as {
        eventId?: unknown;
        sessionId?: unknown;
        runId?: unknown;
        turnId?: unknown;
        provenance?: unknown;
        memories?: unknown;
      };
    if (
      typeof eventId !== "string" ||
      typeof sessionId !== "string" ||
      typeof runId !== "string" ||
      !isRecord(provenance) ||
      !Array.isArray(memories)
    ) {
      return;
    }
    // Crash-replay scope stability: the follow-up remember keeps the QUEUED
    // event payload's scope, never the current config scope (a restart may
    // change config before the replayed drain runs).
    const queuedParams = isRecord(request.params)
      ? (request.params as Record<string, unknown>)
      : null;
    const queuedScope = queuedParams?.scope;
    const followScope =
      typeof queuedScope === "string" && queuedScope.length >= 1
        ? queuedScope
        : scope;
    const at = now();
    let index = 0;
    for (const memory of memories) {
      if (!isRecord(memory)) {
        continue;
      }
      const { body, kind, sensitivity, topics, evidence } = memory as {
        body?: unknown;
        kind?: unknown;
        sensitivity?: unknown;
        topics?: unknown;
        evidence?: unknown;
      };
      if (
        typeof body !== "string" ||
        typeof kind !== "string" ||
        !EXTRACT_KINDS.has(kind) ||
        countCodePoints(body) < 1 ||
        countCodePoints(body) > MEMORY_EXTRACT_BODY_MAX_CP
      ) {
        continue;
      }
      // F-I01-05 P5: AI decides sensitivity with kind; missing/invalid
      // fails closed to sensitive (never upgraded to normal here).
      const resolvedSensitivity: MemoryPrivacySensitivity =
        typeof sensitivity === "string" &&
        EXTRACT_SENSITIVITIES.has(sensitivity)
          ? (sensitivity as MemoryPrivacySensitivity)
          : "sensitive";
      // Re-validate topics here (chain payloads are durable input too):
      // valid topics ride `record.remember` as tags, bounded to remind's
      // tagsMax. Missing/invalid topics keep the legacy empty tags.
      const rememberTags = normalizeTopics(topics).slice(
        0,
        MEMORY_REMIND_TAGS_MAX,
      );
      // Durable chain input is re-validated like every other field: only a
      // user_fact may carry a quote, and it is re-normalized/capped before
      // it rides `record.remember`. Older remind builds are supported by
      // disabling `sendEvidence` (see MemoryServiceOptions) or by the
      // process latch set when a remember is rejected with BAD_REQUEST.
      const rememberEvidence =
        sendEvidence && kind === "user_fact"
          ? normalizeStoredEvidence(evidence)
          : null;
      try {
        repo.enqueueMemoryJob(
          "record.remember",
          sessionId,
          runId,
          followScope,
          stableMemoryJobKey("remember", runId, index),
          JSON.stringify({
            op: "record.remember",
            params: {
              body,
              kind,
              provenance,
              privacy: {
                sensitivity: resolvedSensitivity,
                origin: MEMORY_PRIVACY_ORIGIN_CONVERSATION,
              },
              scope: followScope,
              tags: rememberTags,
              links: [],
              sourceRefs: [eventId],
              runId,
              ...(rememberEvidence !== null
                ? { evidence: rememberEvidence }
                : {}),
            },
          }),
          {
            ...(typeof turnId === "string" ? { turnId } : {}),
            now: at,
          },
        );
      } catch {
        // Best effort per item: one bad item never blocks its siblings.
      }
      index += 1;
      // New remember work can change the similarity graph and the
      // consolidation clusters: the next idle maintenance pass re-runs
      // `maintain.associate` and `maintain.consolidate` once, and a remember
      // also makes activation scoring worth a preview pass.
      associateDirty = true;
      consolidateDirty = true;
      activationDirty = true;
    }
  }

  /**
   * Correction chain: an acked NEW raw correction-source event fans out to
   * exactly one real `record.correct` (new revision + old `active ->
   * superseded` in one CLI txn, old history preserved). The correct job
   * uses its own stable key (derived from the staging key, never reminted),
   * so an append-unknown-outcome replay recovers the event first and the
   * correct second without duplicate revisions. The staged operation row is
   * rebound from the event job to the correct job so its 202-ack status
   * flips only when the REAL correction acks. ATOMIC + THROWING: the
   * correct-job enqueue and the operation rebind commit in ONE repository
   * transaction with payload-identity validation; any failure (including a
   * drifted preexisting payload) throws so the caller does NOT ack the
   * source event, and an idempotent retry under the same key recovers.
   */
  function enqueueCorrectChainCorrection(
    request: Record<string, unknown>,
    chain: Record<string, unknown>,
  ): void {
    const correct = chain.correct;
    if (!isRecord(correct)) {
      return;
    }
    const {
      recordId,
      body,
      provenance,
      sourceEventId,
      correctJobKey,
      clientKey,
      sessionId,
      runId,
      turnId,
    } = correct as {
      recordId?: unknown;
      body?: unknown;
      provenance?: unknown;
      sourceEventId?: unknown;
      correctJobKey?: unknown;
      clientKey?: unknown;
      sessionId?: unknown;
      runId?: unknown;
      turnId?: unknown;
    };
    if (
      typeof recordId !== "string" ||
      typeof body !== "string" ||
      !isRecord(provenance) ||
      typeof sourceEventId !== "string" ||
      typeof correctJobKey !== "string" ||
      typeof clientKey !== "string" ||
      typeof sessionId !== "string" ||
      typeof runId !== "string"
    ) {
      return;
    }
    if (
      countCodePoints(body) < 1 ||
      countCodePoints(body) > MEMORY_CORRECTION_BODY_MAX_CP
    ) {
      return;
    }
    const queuedParams = isRecord(request.params)
      ? (request.params as Record<string, unknown>)
      : null;
    const queuedScope = queuedParams?.scope;
    const followScope =
      typeof queuedScope === "string" && queuedScope.length >= 1
        ? queuedScope
        : scope;
    const at = now();
    // Atomic follow-up + rebind with payload-identity validation. A
    // preexisting correct job with a drifted body is a conflict (throws);
    // a missing operation row throws (fail closed, never a silent orphan).
    // Both throw so the source event stays pending and the retry recovers.
    repo.bindCorrectionFollowupAtomic(
      {
        sessionId,
        runId,
        scope: followScope,
        correctJobKey,
        correctRequestJson: JSON.stringify({
          op: "record.correct",
          params: {
            recordId,
            body,
            kind: MEMORY_CORRECT_KIND,
            provenance,
            // F-I01-05 P3: Companion-issued correct carries privacy;
            // no AI sensitivity decision exists on this user-driven path,
            // so fail closed to sensitive (old version inherited when the
            // CLI omits it, per the decided P3 rule).
            privacy: {
              sensitivity: "sensitive",
              origin: MEMORY_PRIVACY_ORIGIN_CONVERSATION,
            },
            scope: followScope,
            sourceRefs: [sourceEventId],
            runId,
          },
        }),
        ...(typeof turnId === "string" ? { turnId } : {}),
        clientKey,
      },
      { now: at },
    );
  }

  /**
   * One bounded drain tick over due jobs (single flight: concurrent callers
   * share the in-flight tick). Aborts between jobs on preemption/shutdown.
   * The tick owns an abort controller (registered for stop()/preemption)
   * and executes at most MEMORY_DRAIN_BATCH jobs TOTAL per tick: the claim
   * bound shrinks with the remaining budget, so follow-up chains (remember
   * fan-out, correction chains, retries) continue on a later scheduled
   * drain instead of stranding behind an over-wide tick.
   *
   * AUTOMATIC JOB boundary (not batch boundary): a due `maintain.distill`
   * job — the one outbox op that launches the remind local LLM — admits the
   * shared background unit for its own execution only. A busy/closed gate
   * SKIPS that job with an honest diagnostic and NO state touch (still
   * pending, attempts unchanged: no busy-fail, no backoff poisoning), and
   * the tick continues with the next eligible job (no head-of-line
   * starvation), so explicit user-authorized manage work (`record.retire`,
   * `record.reactivate`, correction `event.append`/`record.correct`) always
   * progresses — even while STOPped. The `claimDueMemoryJobs` read below is
   * a read-only due selection (no status mutation), so a skipped automatic
   * job needs no unclaim: nothing was claimed before the admission check.
   */
  function drainOnce(signal?: AbortSignal): Promise<{ executed: number }> {
    if (drainInFlight !== null) {
      return drainInFlight;
    }
    const tick = (async (): Promise<{ executed: number }> => {
      const controller = new AbortController();
      drainControllers.add(controller);
      // An incoming preemption/shutdown signal aborts this tick's
      // controller, so the signal reaching each CLI call below always
      // reflects BOTH the caller and the tick lifetime (stop() aborts the
      // tick controller directly, even for caller-less recovery drains).
      const forwardAbort = (): void => {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          forwardAbort();
        } else {
          signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }
      const tickSignal = controller.signal;
      let executed = 0;
      try {
        while (executed < MEMORY_DRAIN_BATCH) {
          if (stopped || tickSignal.aborted) {
            break;
          }
          const requested = MEMORY_DRAIN_BATCH - executed;
          let due: Array<{
            id: string;
            kind: string;
            requestJson: string;
            attempts: number;
          }>;
          try {
            due = repo.claimDueMemoryJobs(requested, now()).map((job) => ({
              id: job.id,
              kind: job.kind,
              requestJson: job.requestJson,
              attempts: job.attempts,
            }));
          } catch {
            break;
          }
          if (due.length === 0) {
            break;
          }
          const executedBeforePage = executed;
          for (const job of due) {
            if (
              stopped ||
              tickSignal.aborted ||
              executed >= MEMORY_DRAIN_BATCH
            ) {
              break;
            }
            // AUTOMATIC JOB boundary: a due distill admits the shared unit
            // for its own execution only. Busy/closed skips it untouched
            // (durable pending, attempts unchanged) and the tick moves on to
            // the next eligible job — explicit manage work is never blocked
            // behind an automatic job, on any caller path (completion,
            // recovery, idle).
            if (job.kind === AUTOMATIC_DISTILL_KIND && background !== null) {
              const lease = background.tryAcquire(
                BACKGROUND_OWNER_MEMORY_IDLE_DISTILL,
              );
              if (lease === null) {
                log(
                  "info",
                  background.closed
                    ? "memory.distill_skipped_closed"
                    : "memory.distill_skipped_busy",
                );
                continue;
              }
              // Per-job controller: STOP/foreground abort ends ONLY this
              // automatic CLI child (existing preempted path: stays pending
              // with bounded backoff). The lease releases only after the
              // guarded call settles, so no late child overlaps the next
              // admission. Explicit jobs reuse the tick signal directly.
              const jobController = new AbortController();
              backgroundJobControllers.add(jobController);
              const forwardJobAbort = (): void => {
                try {
                  jobController.abort();
                } catch {
                  // Best effort.
                }
              };
              if (tickSignal.aborted) {
                forwardJobAbort();
              } else {
                tickSignal.addEventListener("abort", forwardJobAbort, {
                  once: true,
                });
              }
              try {
                const settled = await executeJob(job, jobController.signal);
                void settled;
                executed += 1;
              } finally {
                tickSignal.removeEventListener("abort", forwardJobAbort);
                backgroundJobControllers.delete(jobController);
                background.release(lease);
              }
              continue;
            }
            const settled = await executeJob(job, tickSignal);
            void settled;
            executed += 1;
          }
          // Gated skips leave no state touch (still pending, attempts
          // unchanged) and the read-only due selection returns them again:
          // a page that made no progress must end the tick here, or a
          // batch-filling skip (e.g. one distill + four explicit jobs with
          // a batch of five) spins forever re-reading the same skipped row.
          if (executed === executedBeforePage) {
            break;
          }
          if (due.length < requested) {
            break;
          }
        }
      } finally {
        if (signal !== undefined) {
          signal.removeEventListener("abort", forwardAbort);
        }
        drainControllers.delete(controller);
      }
      return { executed };
    })();
    drainInFlight = tick;
    const release = (): void => {
      if (drainInFlight === tick) {
        drainInFlight = null;
      }
    };
    tick.then(release, release);
    return tick;
  }

  /**
   * Decision (I) "store every turn": one idle window re-cultivates every
   * foreground-preempted pending run through the SAME authoritative
   * cultivation path (guards, gate admission, raw append, fan-out). Each
   * retried-but-re-aborted run re-schedules itself with a bumped attempt
   * count (bounded); a busy/closed gate at retry time stores the raw turn
   * through the existing busy path (or schedules nothing after STOP).
   */
  async function runExtractionRetries(): Promise<void> {
    for (const runId of [...extractionRetryAttempts.keys()]) {
      if (!started || stopped) {
        return;
      }
      // Pop the PERSISTED attempt count and carry it into the retry: a
      // re-aborted retry re-schedules with `attemptBase` so the counter
      // increments across retries (never resets to 1), bounded at
      // MEMORY_EXTRACT_RETRY_MAX_ATTEMPTS then `memory.extract_gave_up`.
      const attempts = extractionRetryAttempts.get(runId) ?? 0;
      extractionRetryAttempts.delete(runId);
      log("info", "memory.extract_retry", { runId });
      await cultivateRun(runId, { attemptBase: attempts }).catch(
        () => undefined,
      );
      if (stopped) {
        return;
      }
    }
  }

  /**
   * Parse a bounded `topic.pending` page (remind PR #29). Each item is
   * `{id, bodyHash, body, truncated}`; invalid items are skipped whole
   * (never guessed), and at most MEMORY_TOPIC_BACKFILL_LIMIT are processed
   * per idle tick regardless of what remind returned.
   */
  function parseTopicPendingItems(
    data: Record<string, unknown> | null,
  ): Array<{ id: string; bodyHash: string; body: string }> {
    if (data === null || !Array.isArray(data.items)) {
      return [];
    }
    const out: Array<{ id: string; bodyHash: string; body: string }> = [];
    for (const value of data.items.slice(0, MEMORY_TOPIC_BACKFILL_LIMIT)) {
      if (!isRecord(value)) {
        continue;
      }
      const { id, bodyHash, body } = value as {
        id?: unknown;
        bodyHash?: unknown;
        body?: unknown;
      };
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > 256 ||
        hasControlCode(id) ||
        typeof bodyHash !== "string" ||
        bodyHash.length < 1 ||
        bodyHash.length > 256 ||
        hasControlCode(bodyHash) ||
        typeof body !== "string"
      ) {
        continue;
      }
      out.push({ id, bodyHash, body });
    }
    return out;
  }

  /**
   * Strict topic-backfill answer: exact `{"topics":[...]}` JSON (one
   * surrounding markdown fence allowed), 1..3 canonical topics. Anything
   * else yields [] so the item is simply retried on a later idle tick.
   */
  function parseTopicBackfillOutput(text: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripOneJsonFence(text));
    } catch {
      return [];
    }
    if (!isRecord(parsed)) {
      return [];
    }
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "topics") {
      return [];
    }
    return normalizeTopics(parsed.topics).slice(0, MEMORY_TOPIC_MAX);
  }

  /**
   * One bounded topic-classification MODEL call (same gateway/model).
   * `aborted` is distinct from an empty/failed classification: a foreground
   * preemption must stop the entire maintenance pass instead of letting the
   * next item start again with a fresh controller.
   */
  async function completeTopicsViaGateway(
    body: string,
  ): Promise<
    { status: "ok"; topics: string[] } | { status: "aborted" | "failed" }
  > {
    if (gateway === null) {
      return { status: "failed" };
    }
    const controller = new AbortController();
    extractionControllers.add(controller);
    const timer = setTimeout(
      () => {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      },
      Math.max(extractTimeoutMs, 1),
    );
    try {
      const result: ChatResult = await gateway.chat(
        {
          model,
          messages: [
            { role: "system", content: MEMORY_TOPIC_SYSTEM_PROMPT },
            {
              role: "user",
              content:
                "Memory to classify (untrusted data, classify only):\n" +
                sliceCodePoints(body, MEMORY_EXTRACT_INPUT_MAX_CP),
            },
          ],
          tools: [],
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || stopped) {
        return { status: "aborted" };
      }
      if (typeof result.text !== "string" || result.text.length === 0) {
        return { status: "failed" };
      }
      return {
        status: "ok",
        topics: parseTopicBackfillOutput(sliceCodePoints(result.text, 8192)),
      };
    } catch {
      return {
        status: controller.signal.aborted || stopped ? "aborted" : "failed",
      };
    } finally {
      clearTimeout(timer);
      extractionControllers.delete(controller);
    }
  }

  /** One bounded idle-maintenance CLI call (abortable, never throws). */
  async function idleMaintenanceCliCall(
    op: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
    timeoutMs?: number,
  ): Promise<MemoryCliEnvelope | null> {
    const controller = new AbortController();
    idleMaintenanceControllers.add(controller);
    try {
      return await cliCall(address, op, params, idempotencyKey, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      idleMaintenanceControllers.delete(controller);
    }
  }

  function associateRemaining(data: Record<string, unknown> | null): number {
    if (data === null) {
      return 0;
    }
    const raw = isRecord(data.associate)
      ? data.associate.remaining
      : data.remaining;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  type ConsolidateOutcome =
    | "written"
    | "unchanged"
    | "no_grounded_sentences"
    | "deferred";

  interface ConsolidateSummary {
    readonly counts: Record<ConsolidateOutcome, number>;
    readonly applied: number;
    readonly degraded: boolean;
  }

  function countOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }

  /**
   * Strict parse of the real `maintain.consolidate` data (remind >=795c476):
   * `{clusters: [{topic, members, sentencesKept, outcome, ...}], applied,
   * degraded}`. There is NO `remaining`/flat/nested tolerance: a response
   * that does not match is treated as "nothing to retry" (applied = 0).
   */
  function consolidateSummary(
    data: Record<string, unknown> | null,
  ): ConsolidateSummary | null {
    if (data === null || !Array.isArray(data.clusters)) {
      return null;
    }
    const applied = countOf(data.applied);
    if (applied === null || typeof data.degraded !== "boolean") {
      return null;
    }
    const counts: Record<ConsolidateOutcome, number> = {
      written: 0,
      unchanged: 0,
      no_grounded_sentences: 0,
      deferred: 0,
    };
    for (const cluster of data.clusters) {
      if (!isRecord(cluster) || typeof cluster.topic !== "string") {
        return null;
      }
      if (
        countOf(cluster.members) === null ||
        countOf(cluster.sentencesKept) === null
      ) {
        return null;
      }
      const outcome = cluster.outcome;
      if (
        outcome !== "written" &&
        outcome !== "unchanged" &&
        outcome !== "no_grounded_sentences" &&
        outcome !== "deferred"
      ) {
        return null;
      }
      counts[outcome] += 1;
    }
    return { counts, applied, degraded: data.degraded };
  }

  /**
   * One bounded log event per consolidation metric: the logger preserves
   * numeric `status` values as-is (only string statuses are sanitized to
   * the closed allowlist), so counts survive structured-log sanitization.
   */
  function logConsolidateSummary(data: Record<string, unknown> | null): void {
    const summary = consolidateSummary(data);
    if (summary === null) {
      log("warn", "memory.idle.consolidate.invalid", { status: 1 });
      return;
    }
    log("info", "memory.idle.consolidate.applied", {
      status: summary.applied,
    });
    log("info", "memory.idle.consolidate.written", {
      status: summary.counts.written,
    });
    log("info", "memory.idle.consolidate.unchanged", {
      status: summary.counts.unchanged,
    });
    log("info", "memory.idle.consolidate.no_grounded", {
      status: summary.counts.no_grounded_sentences,
    });
    log("info", "memory.idle.consolidate.deferred", {
      status: summary.counts.deferred,
    });
    log("info", "memory.idle.consolidate.degraded", {
      status: summary.degraded ? 1 : 0,
    });
  }

  interface ActivationSummary {
    readonly scored: number;
    readonly scoreFailed: number;
    readonly retired: number;
    readonly reactivated: number;
    readonly wouldRetire: number;
    readonly wouldReactivate: number;
    readonly degraded: boolean;
  }

  /** Strict parse of the real FLAT `maintain.activation` response data. */
  function activationSummary(
    data: Record<string, unknown> | null,
  ): ActivationSummary | null {
    if (data === null || typeof data.degraded !== "boolean") {
      return null;
    }
    const fields = [
      "scored",
      "scoreFailed",
      "retired",
      "reactivated",
      "wouldRetire",
      "wouldReactivate",
    ] as const;
    const parsed: Partial<Record<(typeof fields)[number], number>> = {};
    for (const field of fields) {
      const value = countOf(data[field]);
      if (value === null) {
        return null;
      }
      parsed[field] = value;
    }
    return {
      scored: parsed.scored as number,
      scoreFailed: parsed.scoreFailed as number,
      retired: parsed.retired as number,
      reactivated: parsed.reactivated as number,
      wouldRetire: parsed.wouldRetire as number,
      wouldReactivate: parsed.wouldReactivate as number,
      degraded: data.degraded,
    };
  }

  /** One bounded numeric-status log event per activation metric. */
  function logActivationSummary(data: Record<string, unknown> | null): void {
    const summary = activationSummary(data);
    if (summary === null) {
      log("warn", "memory.idle.activation.invalid", { status: 1 });
      return;
    }
    log("info", "memory.idle.activation.scored", {
      status: summary.scored,
    });
    log("info", "memory.idle.activation.score_failed", {
      status: summary.scoreFailed,
    });
    log("info", "memory.idle.activation.would_retire", {
      status: summary.wouldRetire,
    });
    log("info", "memory.idle.activation.would_reactivate", {
      status: summary.wouldReactivate,
    });
    log("info", "memory.idle.activation.retired", {
      status: summary.retired,
    });
    log("info", "memory.idle.activation.reactivated", {
      status: summary.reactivated,
    });
    log("info", "memory.idle.activation.degraded", {
      status: summary.degraded ? 1 : 0,
    });
  }

  /**
   * One bounded idle maintenance pass (remind PR #29), in order:
   * 1. Topic backfill: `topic.pending {scope, limit: 8}` -> one MODEL call
   *    per item (same gateway/model/abort/timeout as extraction) -> a
   *    direct `topic.set` write keyed by (id, bodyHash). No outbox schema
   *    change is needed: the stable key makes reminder replay idempotent.
   *    Each MODEL call holds the shared background admission unit: a busy
   *    gate skips the WHOLE pass (no overlap with extraction/shadow), and a
   *    foreground preemption aborts it instead of continuing with the next
   *    item.
   * 2. `maintain.associate {scope}` once when a remember was enqueued since
   *    the last pass or the last pass reported `remaining > 0`, and ONLY
   *    once no outbox job is pending any more: a remember awaiting retry
   *    must land before the similarity pass snapshots the store. Otherwise
   *    `associateDirty` stays armed for a later tick.
   * 3. `maintain.consolidate {scope}` (NO limit: remind's batchMax
   *    rejects a larger limit) after association (clusters depend on
   *    topics/edges) when a remember/association armed it, and on the next
   *    tick only while its real response reported `applied > 0`. A dirty
   *    remember also arms consolidation.
   * 4. `maintain.activation {scope, limit}` at most once per idle pass
   *    when a remember/consolidation armed it. Preview-only: remind's
   *    config has `activation.apply=false`, so this only scores importance
   *    and reports wouldRetire/wouldReactivate (never status changes, and
   *    Companion never sends `apply: true`).
   * An old remind answers BAD_REQUEST: latch that surface until restart
   * (silent, no per-tick retry storm).
   */
  async function runIdleMaintenance(): Promise<void> {
    if (!started || stopped) {
      return;
    }
    // Shutdown/drain (closed gate) lands no new autonomous maintenance.
    if (background?.closed === true) {
      return;
    }
    const epoch = foregroundEpoch;
    const passActive = (): boolean =>
      started && !stopped && foregroundEpoch === epoch;
    if (!topicsUnsupported && gateway !== null) {
      const startedAt = now();
      const counts = {
        pending: 0,
        processed: 0,
        assigned: 0,
        skipped: 0,
        failed: 0,
        degraded: 0,
      };
      let attempted = false;
      let errorCode: string | null = null;
      let completed = false;
      try {
        const pending = await idleMaintenanceCliCall("topic.pending", {
          scope,
          limit: MEMORY_TOPIC_BACKFILL_LIMIT,
        });
        if (pending === null) {
          errorCode = "cli_failed";
          return;
        }
        attempted = true;
        if (!passActive()) {
          return;
        }
        if (!pending.ok) {
          if (pending.code === "BAD_REQUEST") {
            topicsUnsupported = true;
          }
          errorCode = maintenanceErrorCode(pending.code);
          return;
        }
        const items = parseTopicPendingItems(pending.data);
        counts.pending = items.length;
        for (const item of items) {
          if (!passActive()) {
            return;
          }
          // Same non-overlap invariant as extraction/shadow: one shared
          // background unit around each model-heavy maintenance call. A
          // busy/closed gate skips the rest of this pass (retried later)
          // instead of overlapping another background model call.
          const reservation =
            background === null
              ? null
              : background.tryAcquire(BACKGROUND_OWNER_MEMORY_IDLE_DISTILL);
          if (background !== null && reservation === null) {
            counts.skipped += 1;
            errorCode = "busy";
            return;
          }
          counts.processed += 1;
          let result: Awaited<ReturnType<typeof completeTopicsViaGateway>>;
          try {
            result = await completeTopicsViaGateway(item.body);
          } finally {
            if (reservation !== null) {
              background?.release(reservation);
            }
          }
          if (result.status === "aborted") {
            // Foreground preemption cancels the ENTIRE pass: do not start
            // the next item with a fresh controller, and do not associate.
            counts.skipped += 1;
            errorCode = "preempted";
            return;
          }
          if (!passActive()) {
            return;
          }
          const topics = result.status === "ok" ? result.topics.sort() : [];
          if (topics.length === 0) {
            // No valid categories this pass: leave the item pending.
            counts.skipped += 1;
            continue;
          }
          const key = stableMemoryJobKey("topic", item.id, item.bodyHash);
          const stored = await idleMaintenanceCliCall(
            "topic.set",
            {
              scope,
              id: item.id,
              bodyHash: item.bodyHash,
              topics,
            },
            key,
          );
          if (!passActive()) {
            return;
          }
          if (stored === null) {
            counts.failed += 1;
            errorCode = "cli_failed";
            continue;
          }
          if (!stored.ok) {
            counts.failed += 1;
            errorCode = maintenanceErrorCode(stored.code);
            if (stored.code === "BAD_REQUEST") {
              topicsUnsupported = true;
              break;
            }
            continue;
          }
          counts.assigned += 1;
        }
        completed = true;
      } finally {
        if (!completed && errorCode === null) {
          errorCode = "preempted";
        }
        if (attempted && (counts.pending > 0 || errorCode !== null)) {
          recordMaintenanceRun({
            op: "topic.backfill",
            startedAt,
            ok: errorCode === null,
            ...(errorCode !== null ? { errorCode } : {}),
            counts,
          });
        }
      }
    }
    if (!passActive()) {
      return;
    }
    if (!associateUnsupported && associateDirty) {
      // Pending (including not-yet-due) outbox work must land first: a
      // remember retry acking after association would otherwise leave the
      // new record unassociated until another enqueue/restart.
      let outstanding = 1;
      try {
        outstanding = repo.countOutstandingMemoryJobs();
      } catch {
        outstanding = 1;
      }
      if (outstanding > 0) {
        return;
      }
      // A nonce makes every pass unique across service restarts: a
      // process-local sequence would reset to 1 and replay remind's stored
      // response from the previous process. The same nonce is the retry key
      // for this one logical pass.
      const passNonce = randomUUID();
      const key = stableMemoryJobKey("associate", scope, passNonce);
      const startedAt = now();
      const associate = await idleMaintenanceCliCall(
        "maintain.associate",
        { scope },
        key,
        distillTimeoutMs,
      );
      if (!passActive()) {
        return;
      }
      if (associate !== null) {
        const remaining = associate.ok
          ? Math.max(0, Math.floor(associateRemaining(associate.data)))
          : 0;
        recordMaintenanceRun({
          op: "maintain.associate",
          startedAt,
          ok: associate.ok,
          ...(associate.ok
            ? {}
            : { errorCode: maintenanceErrorCode(associate.code) }),
          counts: associate.ok ? { remaining } : {},
        });
        if (!associate.ok && associate.code === "BAD_REQUEST") {
          associateUnsupported = true;
        } else if (associate.ok) {
          associateDirty = remaining > 0;
          // Association may have written topics/edges: consolidation
          // clusters depend on them, so run it after associate this pass.
          consolidateDirty = true;
        }
      }
    }
    if (!passActive()) {
      return;
    }
    if (!consolidateUnsupported && consolidateDirty) {
      const passNonce = randomUUID();
      const key = stableMemoryJobKey("consolidate", scope, passNonce);
      // No `limit`: remind's consolidate batchMax (default 5) rejects a
      // larger limit with LIMIT_EXCEEDED, so the CLI applies its configured
      // batch size (the request MUST stay {scope} only).
      const startedAt = now();
      const consolidate = await idleMaintenanceCliCall(
        "maintain.consolidate",
        { scope },
        key,
        distillTimeoutMs,
      );
      if (!passActive()) {
        return;
      }
      if (consolidate !== null) {
        if (
          !consolidate.ok &&
          (consolidate.code === "BAD_REQUEST" ||
            consolidate.code === "LIMIT_EXCEEDED")
        ) {
          recordMaintenanceRun({
            op: "maintain.consolidate",
            startedAt,
            ok: false,
            errorCode: maintenanceErrorCode(consolidate.code),
            counts: {},
          });
          consolidateUnsupported = true;
          consolidateDirty = false;
          if (consolidate.code === "LIMIT_EXCEEDED") {
            log("warn", "memory.idle.consolidate_unsupported", {
              status: consolidate.code,
            });
          }
        } else if (consolidate.ok) {
          const summary = consolidateSummary(consolidate.data);
          if (summary === null) {
            recordMaintenanceRun({
              op: "maintain.consolidate",
              startedAt,
              ok: false,
              errorCode: "invalid_response",
              counts: {},
            });
          } else {
            recordMaintenanceRun({
              op: "maintain.consolidate",
              startedAt,
              ok: true,
              counts: {
                applied: summary.applied,
                written: summary.counts.written,
                unchanged: summary.counts.unchanged,
                no_grounded: summary.counts.no_grounded_sentences,
                deferred: summary.counts.deferred,
                degraded: summary.degraded ? 1 : 0,
              },
            });
          }
          // Re-arm only for a real write: deferred/no_grounded clusters are
          // retried on the next remember/associate re-arm, never every tick.
          consolidateDirty = summary !== null && summary.applied > 0;
          activationDirty = true;
          logConsolidateSummary(consolidate.data);
        } else {
          recordMaintenanceRun({
            op: "maintain.consolidate",
            startedAt,
            ok: false,
            errorCode: maintenanceErrorCode(consolidate.code),
            counts: {},
          });
        }
      }
    }
    if (!passActive()) {
      return;
    }
    if (!activationUnsupported && activationDirty) {
      // Preview-only by decision (2026-10-24): remind's config keeps
      // `activation.apply = false`, so this op only SCORES derived
      // importance and reports wouldRetire/wouldReactivate counts; it
      // never changes record status. Companion must never send
      // `apply: true` here until activation is explicitly tuned.
      const passNonce = randomUUID();
      const key = stableMemoryJobKey("activation", scope, passNonce);
      const startedAt = now();
      const activation = await idleMaintenanceCliCall(
        "maintain.activation",
        { scope, limit: MEMORY_ACTIVATION_LIMIT },
        key,
        distillTimeoutMs,
      );
      if (!passActive()) {
        return;
      }
      // At most once per idle pass: consumed even on a transient failure
      // (a later remember/consolidation re-arms it).
      activationDirty = false;
      if (activation !== null) {
        if (
          !activation.ok &&
          (activation.code === "BAD_REQUEST" ||
            activation.code === "LIMIT_EXCEEDED")
        ) {
          recordMaintenanceRun({
            op: "maintain.activation",
            startedAt,
            ok: false,
            errorCode: maintenanceErrorCode(activation.code),
            counts: {},
          });
          activationUnsupported = true;
          if (activation.code === "LIMIT_EXCEEDED") {
            log("warn", "memory.idle.activation_unsupported", {
              status: activation.code,
            });
          }
        } else if (activation.ok) {
          const summary = activationSummary(activation.data);
          if (summary === null) {
            recordMaintenanceRun({
              op: "maintain.activation",
              startedAt,
              ok: false,
              errorCode: "invalid_response",
              counts: {},
            });
          } else {
            recordMaintenanceRun({
              op: "maintain.activation",
              startedAt,
              ok: true,
              counts: {
                scored: summary.scored,
                score_failed: summary.scoreFailed,
                retired: summary.retired,
                reactivated: summary.reactivated,
                would_retire: summary.wouldRetire,
                would_reactivate: summary.wouldReactivate,
                degraded: summary.degraded ? 1 : 0,
              },
            });
          }
          logActivationSummary(activation.data);
        } else {
          recordMaintenanceRun({
            op: "maintain.activation",
            startedAt,
            ok: false,
            errorCode: maintenanceErrorCode(activation.code),
            counts: {},
          });
        }
      }
    }
  }

  /** Single-flight wrapper: concurrent idle paths share one maintenance pass. */
  function runIdleMaintenanceOnce(): Promise<void> {
    if (idleMaintenanceInFlight !== null) {
      return idleMaintenanceInFlight;
    }
    const run = runIdleMaintenance();
    idleMaintenanceInFlight = run;
    const release = (): void => {
      if (idleMaintenanceInFlight === run) {
        idleMaintenanceInFlight = null;
      }
    };
    run.then(release, release);
    return run;
  }

  /**
   * One bounded idle cultivation batch (single flight). The gate lives at
   * the AUTOMATIC JOB boundary inside `drainOnce` — never around this whole
   * batch — so explicit user-authorized manage work always progresses, even
   * while STOPped. Ordering per tick:
   * 0. Foreground-preempted extraction retries re-cultivate FIRST (decision
   *    (I) "store every turn"): their raw storage must never queue behind a
   *    distill anchor that this tick could otherwise consume.
   * 1. A still-pending distill job whose backoff expired is drained (a
   *    transiently failed/preempted distill retries WITHOUT another
   *    foreground completion or restart); a not-yet-due one only rearms.
   *    A busy/closed gate skips ONLY the distill execution (durable pending,
   *    attempts unchanged) while explicit jobs in the same tick still run.
   * 2. Any other due foreground backlog drains first (even with no run
   *    context yet, so crash-recovered or externally enqueued work never
   *    strands behind a missing anchor). Explicit manage jobs never consult
   *    the gate: they complete while STOPped.
   * 3. Only with no due backlog and a completed-run anchor is one
   *    `maintain.distill` enqueued, then drained. A degraded
   *    (model-unavailable) distill answer acks normally with zero writes:
   *    cultivation degrades, answering never fails.
   */
  async function runIdleDistill(): Promise<void> {
    if (!started || stopped) {
      return;
    }
    if (idleDrainActive) {
      return;
    }
    // Decision (I) retries first: a preempted turn re-cultivates on this
    // idle window before any distill anchor work below.
    await runExtractionRetries().catch(() => undefined);
    if (!started || stopped) {
      return;
    }
    // Derived maintenance runs once per idle tick, after retries (their new
    // remembers arm `associateDirty`): bounded topic backfill first, then one
    // `maintain.associate` when there is work. Old remind latches skip it.
    await runIdleMaintenanceOnce().catch(() => undefined);
    if (!started || stopped) {
      return;
    }
    if (pendingDistillJobId !== null) {
      let nextDueAt: number | null = null;
      try {
        const pending = repo.getMemoryJob(pendingDistillJobId);
        if (pending !== null && pending.status === "pending") {
          nextDueAt = pending.nextDueAt;
        }
      } catch {
        armIdleTimer();
        return;
      }
      if (nextDueAt === null) {
        pendingDistillJobId = null;
      } else if (nextDueAt > now()) {
        // Single flight: a distill is already pending but its bounded
        // backoff has not expired yet. Rearm the one-shot timer so the
        // queue keeps being polled after this early return (no busy loop).
        armIdleTimer();
        return;
      }
      // Else: the pending distill is due — fall through and drain it below
      // instead of rearming forever.
    }
    let pending = 0;
    try {
      pending = repo.countPendingMemoryJobs(now());
    } catch {
      armIdleTimer();
      return;
    }
    if (pending > 0) {
      // Foreground backlog first (even without a run anchor): drain it
      // instead of cultivating. NO batch-level admission: the automatic-job
      // boundary inside `drainOnce` skips only distill executions while
      // explicit manage jobs in the same tick still run — even while STOP
      // closed the gate (no starvation, no loss, no spin).
      idleDrainActive = true;
      try {
        await drainOnce().catch(() => undefined);
      } finally {
        idleDrainActive = false;
        armIdleTimer();
      }
      return;
    }
    const anchor = lastCompletedRun;
    if (anchor === null) {
      // No run context yet: rearm so a later completion still cultivates.
      armIdleTimer();
      return;
    }
    let enqueuedId: string | null = null;
    try {
      const { row } = repo.enqueueMemoryJob(
        "maintain.distill",
        anchor.sessionId,
        anchor.runId,
        scope,
        stableMemoryJobKey("distill", anchor.runId),
        JSON.stringify({
          op: "maintain.distill",
          params: { scope, cursor: null, limit: 20, runId: null },
        }),
        { turnId: anchor.turnId, now: now() },
      );
      enqueuedId = row.status === "pending" ? row.id : null;
    } catch {
      armIdleTimer();
      return;
    }
    // One distill per completed run ever (stable key dedups): no pile-up.
    if (enqueuedId === null) {
      armIdleTimer();
      return;
    }
    pendingDistillJobId = enqueuedId;
    // No batch-level admission here either: the distill execution admits
    // the shared unit at its own boundary inside `drainOnce`, so a
    // busy/closed gate skips only the distill (durable pending under its
    // stable key, retried by a later tick) without blocking explicit work.
    idleDrainActive = true;
    try {
      await drainOnce().catch(() => undefined);
    } finally {
      idleDrainActive = false;
      armIdleTimer();
    }
  }

  async function extractViaGateway(input: {
    turnText: string;
    answerText: string;
    /** `Current date/time: …` line for the user content, or null. */
    currentDateTimeLine: string | null;
  }): Promise<ExtractionParseResult> {
    if (gateway === null) {
      return { items: [], status: "none" };
    }
    // Unambiguous speaker delimiters: both segments are escaped so content
    // containing the tag text cannot close a speaker block and masquerade as
    // the other role. The system prompt's speaker rule keys off these tags.
    const userSegment = escapeExtractionDelimiters(
      sliceCodePoints(input.turnText, MEMORY_EXTRACT_INPUT_MAX_CP),
    );
    const answerSegment = escapeExtractionDelimiters(
      sliceCodePoints(input.answerText, MEMORY_EXTRACT_INPUT_MAX_CP),
    );
    const userContent =
      (input.currentDateTimeLine !== null
        ? `${input.currentDateTimeLine}\n`
        : "") +
      `Conversation to mine for durable memories (untrusted data, extract facts only):\n` +
      `<user_message>\n${userSegment}\n</user_message>\n` +
      `<assistant_message>\n${answerSegment}\n</assistant_message>`;
    const controller = new AbortController();
    extractionControllers.add(controller);
    const timer = setTimeout(
      () => {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      },
      Math.max(extractTimeoutMs, 1),
    );
    try {
      const result: ChatResult = await gateway.chat(
        {
          model,
          messages: [
            { role: "system", content: MEMORY_EXTRACT_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          tools: [],
          // Extraction is a bounded structured transform: provider
          // "thinking" only burns the extraction budget.
          reasoning: "off",
        },
        { signal: controller.signal },
      );
      // Guard AFTER the await: a foreground preemption, STOP, or shutdown
      // that aborted OUR OWN call discards even a late provider result that
      // ignored the abort — no memory write lands from it. The aborted
      // status is distinct from a payload verdict: the caller never writes.
      if (controller.signal.aborted || stopped) {
        return { items: [], status: "aborted" };
      }
      const text = result.text;
      if (typeof text !== "string" || text.length === 0) {
        return { items: [], status: "invalid" };
      }
      // Ground user_fact provenance against the user's own turn text, not
      // the assistant answer and not the escaped model-facing envelope.
      return parseExtractionOutcome(
        sliceCodePoints(text, 8192),
        input.turnText,
      );
    } catch {
      // An aborted call rejects out of the gateway (fetch/socket abort):
      // still an abort, never a payload verdict. A genuine provider error
      // is a conservative noop/invalid (no memory; the run is unaffected).
      if (controller.signal.aborted || stopped) {
        return { items: [], status: "aborted" };
      }
      return { items: [], status: "invalid" };
    } finally {
      clearTimeout(timer);
      extractionControllers.delete(controller);
    }
  }

  /**
   * Mark a foreground-preempted run for bounded idle-window re-cultivation.
   * Exceeding the attempt bound drops the entry with an honest diagnostic
   * (never an infinite retry loop).
   */
  /**
   * Mark a foreground-preempted run for bounded idle-window re-cultivation.
   * `attemptBase` carries the PERSISTED attempt count across retries (the
   * idle retry pass re-invokes `cultivateRun` with the count it popped) so
   * the counter never resets to 1 across retries. Exceeding the attempt
   * bound gives up with an honest diagnostic (never an infinite loop).
   */
  function scheduleExtractionRetry(runId: string, attemptBase?: number): void {
    const attempts = attemptBase ?? extractionRetryAttempts.get(runId) ?? 0;
    if (attempts >= MEMORY_EXTRACT_RETRY_MAX_ATTEMPTS) {
      extractionRetryAttempts.delete(runId);
      log("warn", "memory.extract_gave_up", {
        runId,
        attempt: attempts,
      });
      return;
    }
    extractionRetryAttempts.set(runId, attempts + 1);
    log("info", "memory.extract_retry_scheduled", {
      runId,
      attempt: attempts + 1,
    });
  }

  function onRunCompleted(runId: string): void {
    void cultivateRun(runId).catch(() => undefined);
  }

  /**
   * Post-completion cultivation for one settled run. Also re-invoked by the
   * idle window for foreground-preempted retries (same authoritative path:
   * guards, gate admission, raw append, fan-out). Fire-and-forget safe:
   * every failure path returns silently (the run already completed; memory
   * is best-effort and durable where enqueued). Authoritative guards first:
   * completed status + current selection + same-session binding.
   */
  async function cultivateRun(
    runId: string,
    hints?: { attemptBase?: number },
  ): Promise<void> {
    if (!started || stopped) {
      return;
    }
    let run: {
      id: string;
      turnId: string;
      sessionId: string;
      status: string;
      result: unknown;
      finishedAt: number | null;
    };
    try {
      const loaded = repo.getRun(runId);
      run = {
        id: loaded.id,
        turnId: loaded.turnId,
        sessionId: loaded.sessionId,
        status: loaded.status,
        result: loaded.result,
        finishedAt: loaded.finishedAt,
      };
    } catch {
      return;
    }
    // Extraction can never mutate a cancelled/stopped run: only completed
    // runs with a result cultivate. Anything else returns silently.
    if (run.status !== "completed" || run.result === null) {
      return;
    }
    let turnText = "";
    let temporal: { now: number; timeZone: string } | null = null;
    try {
      const turn = repo.getTurn(run.turnId);
      if (turn.sessionId !== run.sessionId) {
        return;
      }
      turnText = turn.input.kind === "user_text" ? turn.input.text : "";
      temporal = turn.frozenContext?.temporal ?? null;
    } catch {
      return;
    }
    // Current-selection check: a superseded retry (no longer selected)
    // never cultivates, even when completed.
    try {
      const selection = repo.getSelection(run.turnId);
      if (selection === null || selection.runId !== run.id) {
        return;
      }
    } catch {
      return;
    }
    lastCompletedRun = {
      sessionId: run.sessionId,
      runId: run.id,
      turnId: run.turnId,
    };
    const result = run.result as {
      version?: unknown;
      text?: unknown;
      answer?: unknown;
    };
    const answerText = typeof result.text === "string" ? result.text : "";
    if (answerText.length === 0) {
      return;
    }
    // Feedback first (gateway-independent): only structural mN citations
    // from the ACCEPTED answer's citation arrays. V1 results carry no
    // answer and therefore never yield feedback.
    try {
      enqueueFeedbackJobs(run, result.answer);
    } catch {
      // Best effort: feedback never fails completion.
    }
    // Decision (I): store every turn, RAW-FIRST. The RAW `event.append`
    // payload is built and enqueued for EVERY completed selected turn
    // IMMEDIATELY at commit time — before and independent of the
    // extraction attempt — so an aborted/invalid extraction or a busy
    // background slot forgoes only the remember fan-out, NEVER the raw
    // event. The extraction's remember jobs later reference this event via
    // `sourceRefs`. The STOP/shutdown gate is honored first: a CLOSED gate
    // lands no write of any kind for this run (no late writes after STOP).
    const observedAt =
      run.finishedAt !== null && Number.isFinite(run.finishedAt)
        ? new Date(run.finishedAt).toISOString()
        : new Date(now()).toISOString();
    const eventId = `evt-${run.id}`;
    const eventBody = sliceCodePoints(
      `User: ${turnText}\nAssistant: ${answerText}`,
      MEMORY_EVENT_BODY_MAX_CP,
    );
    const provenance = {
      source: MEMORY_PROVENANCE_SOURCE,
      observedAt,
    };
    const enqueueRawEvent = (): boolean => {
      try {
        repo.enqueueMemoryJob(
          "event.append",
          run.sessionId,
          run.id,
          scope,
          stableMemoryJobKey("event", run.id),
          JSON.stringify({
            op: "event.append",
            params: {
              eventId,
              sessionId: run.sessionId,
              turnId: run.turnId,
              body: eventBody,
              provenance,
              privacy: {
                sensitivity: MEMORY_PRIVACY_SENSITIVITY_NORMAL,
                origin: MEMORY_PRIVACY_ORIGIN_CONVERSATION,
              },
              scope,
              runId: run.id,
            },
            // No remember fan-out rides on the raw event's chain:
            // extracted memories enqueue their own remember jobs below.
            chain: {
              eventId,
              sessionId: run.sessionId,
              runId: run.id,
              turnId: run.turnId,
              provenance,
              memories: [],
            },
          }),
          { turnId: run.turnId, now: now() },
        );
      } catch {
        return false;
      }
      log("info", "memory.event_queued", {
        runId: run.id,
        bytes: eventBody.length,
      });
      return true;
    };
    // STOP/shutdown gate (authoritative, checked BEFORE any enqueue): a
    // CLOSED gate admits nothing new — no extraction AND no raw
    // event.append. A paused control never closes the gate (I03-09 keeps
    // memory admission open while paused).
    if (background?.closed) {
      log("info", "memory.extract_skipped_closed", { runId: run.id });
      return;
    }
    // RAW-FIRST enqueue: the committed turn's event.append lands here, in
    // every path below (aborted, invalid, busy, and success alike). The
    // remember fan-out references this event via `sourceRefs`.
    if (!enqueueRawEvent()) {
      return;
    }
    // Structured extraction (gateway-dependent, conservative noop).
    // Background admission: at most ONE model-heavy background unit runs
    // at a time. A merely BUSY gate keeps the raw turn durable (enqueued
    // above): the skipped extraction forgoes only the remember fan-out.
    // The automatic-job boundary inside `drainOnce` admits-or-skips ONLY
    // the distill execution itself (explicit jobs always run), so nothing
    // already-durable is lost, no catchup invented, no auto-revive of
    // this skipped extraction on release.
    const extractionLease =
      background?.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION) ?? null;
    if (background !== null && extractionLease === null) {
      log("info", "memory.extract_skipped_busy", { runId: run.id });
      // A just-scheduled outbox job CAN be missed by an in-flight drain
      // tick whose claim pass already ran (e.g. the start() recovery
      // tick): blindly returning that tick's `executed: 0` promise would
      // strand the committed raw turn until the 5-minute idle tick. Join
      // the in-flight tick first, then drain once more: the fresh tick
      // claims and executes the new event.append.
      const inflightTick = drainInFlight;
      if (inflightTick !== null) {
        await inflightTick.catch(() => undefined);
      }
      await drainOnce().catch(() => undefined);
      return;
    }
    let outcome: ExtractionParseResult;
    try {
      // The Turn's FROZEN temporal is authoritative (the instant the turn
      // was created, in the configured zone); a legacy/absent snapshot
      // falls back to the run's finish instant + the configured zone.
      const extractionInstant =
        temporal !== null && Number.isFinite(temporal.now)
          ? temporal.now
          : run.finishedAt !== null && Number.isFinite(run.finishedAt)
            ? run.finishedAt
            : now();
      const extractionZone = temporal?.timeZone ?? timeZone;
      const rendered = formatZonedDateTime(extractionInstant, extractionZone);
      outcome = await extractViaGateway({
        turnText,
        answerText,
        currentDateTimeLine:
          rendered !== null
            ? `Current date/time: ${rendered} ${extractionZone}`
            : null,
      });
    } finally {
      if (extractionLease !== null) {
        background?.release(extractionLease);
      }
    }
    if (outcome.status === "aborted") {
      // Our OWN gateway call was aborted (a foreground preemption, its
      // own extraction budget bound, or shutdown): even a late provider
      // result is discarded and NO remember fan-out lands for this run
      // yet. The raw event.append is ALREADY durable (raw-first above):
      // an aborted attempt never skips it. Bounded bounded re-extraction:
      // a FOREGROUND-preempted attempt (service still running, gate still
      // open) stays pending and re-cultivates via the full path on the
      // next idle window, bounded; STOP/shutdown aborts never re-schedule.
      log("info", "memory.extract_aborted", { runId: run.id });
      if (!stopped && !(background?.closed ?? false)) {
        scheduleExtractionRetry(run.id, hints?.attemptBase);
      }
      await drainOnce().catch(() => undefined);
      return;
    }
    if (outcome.items.length === 0) {
      // Split diagnostics (fixed codes only): a valid strict-JSON empty
      // list is `memory.extract_none` (genuine nothing-to-remember);
      // anything else (unparseable, wrong shape, or all items rejected)
      // is `memory.extract_invalid` — the old single extract_empty code
      // conflated the two and hid real model-output-shape failures.
      log(
        "info",
        outcome.status === "invalid"
          ? "memory.extract_invalid"
          : "memory.extract_none",
        { runId: run.id },
      );
      await drainOnce().catch(() => undefined);
      return;
    }
    // Authoritative recheck AFTER the async gateway call: selection,
    // completion, and shutdown may have changed while awaited. A
    // superseded retry or a stopped service never enqueues remember jobs
    // (the raw event above is already durable and stays).
    const supersededOrStopped = (): boolean => {
      if (!started || stopped) {
        return true;
      }
      try {
        const fresh = repo.getRun(runId);
        if (
          fresh.status !== "completed" ||
          fresh.result === null ||
          fresh.sessionId !== run.sessionId ||
          fresh.turnId !== run.turnId
        ) {
          return true;
        }
        const freshSelection = repo.getSelection(fresh.turnId);
        return freshSelection === null || freshSelection.runId !== fresh.id;
      } catch {
        return true;
      }
    };
    if (supersededOrStopped()) {
      // The raw event.append above is durable but not yet drained: drain
      // before returning so the committed turn's raw write still lands.
      await drainOnce().catch(() => undefined);
      return;
    }
    // Remember fan-out for the extracted items: the same stable-keyed
    // chain logic the event.append ack fan-out uses, invoked directly so
    // the fan-out no longer depends on the raw event's chain payload.
    enqueueRememberChainMemories(
      { params: { scope } },
      {
        eventId,
        sessionId: run.sessionId,
        runId: run.id,
        turnId: run.turnId,
        provenance,
        memories: outcome.items.map((memory) => ({
          body: memory.body,
          kind: memory.kind,
          sensitivity: memory.sensitivity,
          ...(memory.topics !== undefined ? { topics: memory.topics } : {}),
          ...(memory.evidence !== undefined
            ? { evidence: memory.evidence }
            : {}),
        })),
      },
    );
    await drainOnce().catch(() => undefined);
  }

  /**
   * Cite-gated feedback: ONLY real accepted completed-answer memory
   * citations yield feedback. Reads the answer's citation arrays (never
   * prose, never exposure/text mention), resolves each cited mN against
   * THIS run's exposure snapshot with matching scope, binds the grant, and
   * enqueues one stable feedback job per recall id.
   */
  function enqueueFeedbackJobs(
    run: { id: string; sessionId: string },
    answer: unknown,
  ): void {
    if (!isRecord(answer) || !Array.isArray(answer.parts)) {
      return;
    }
    let ordinals: number[];
    try {
      ordinals = collectCitedMemoryOrdinals(
        answer as Parameters<typeof collectCitedMemoryOrdinals>[0],
      );
    } catch {
      return;
    }
    if (ordinals.length === 0) {
      return;
    }
    let exposures: Array<{
      recallId: string;
      recordId: string;
      citation: string;
      scope: string;
    }>;
    try {
      exposures = repo.listMemoryExposures(run.id).map((exposure) => ({
        recallId: exposure.recallId,
        recordId: exposure.recordId,
        citation: exposure.citation,
        scope: exposure.scope,
      }));
    } catch {
      return;
    }
    const byCitation = new Map(exposures.map((item) => [item.citation, item]));
    const byRecall = new Map<string, Set<string>>();
    for (const ordinal of ordinals) {
      const exposure = byCitation.get(`m${ordinal}`);
      // Same-run exposure with matching scope only: cross-run, cross-scope,
      // or uncited exposures grant nothing and send no feedback.
      if (exposure === undefined || exposure.scope !== scope) {
        continue;
      }
      try {
        repo.grantMemoryCitation({
          runId: run.id,
          citation: exposure.citation,
          recordId: exposure.recordId,
          recallId: exposure.recallId,
          sessionId: run.sessionId,
          scope,
        });
      } catch {
        continue;
      }
      let set = byRecall.get(exposure.recallId);
      if (set === undefined) {
        set = new Set<string>();
        byRecall.set(exposure.recallId, set);
      }
      set.add(exposure.recordId);
    }
    const at = now();
    for (const [recallId, recordIds] of byRecall) {
      if (recordIds.size === 0) {
        continue;
      }
      try {
        repo.enqueueMemoryJob(
          "record.feedback",
          run.sessionId,
          run.id,
          scope,
          stableMemoryJobKey("feedback", run.id, recallId),
          JSON.stringify({
            op: "record.feedback",
            params: {
              recallId,
              recordIds: [...recordIds].sort(),
              scope,
              runId: run.id,
            },
          }),
          { now: at },
        );
      } catch {
        // Best effort per recall: siblings still enqueue.
      }
    }
  }

  const recallHook = {
    scope,
    recall: async (
      query: string,
      signal: AbortSignal,
      onFailure?: (code: MemoryCliFailureCode) => void,
    ): Promise<ReadonlyArray<MemoryRecallItem>> => {
      if (!started || stopped || signal.aborted) {
        // I01-06 (additive): report the fixed unavailable code so the run's
        // memory status stays visible; the fail-open empty result is
        // unchanged. A post-abort report is skipped: the kernel derives
        // `unavailable` from the aborted signal itself.
        if (!signal.aborted) {
          onFailure?.("cli_unavailable");
        }
        return [];
      }
      const trimmed = sliceCodePoints(query, MEMORY_RECALL_QUERY_MAX_CP);
      if (trimmed.length === 0) {
        return [];
      }
      let envelope: MemoryCliEnvelope;
      try {
        envelope = await cliCall(
          address,
          "record.recall",
          {
            query: trimmed,
            scope,
            runId: MEMORY_RECALL_RUN_MARKER,
            limit: recallLimit,
          },
          undefined,
          { signal },
        );
      } catch (error) {
        // Fail-open: every recall failure yields a memoryless response
        // (F-I01-07). A protocol-version mismatch (F-I01-01: version is
        // in the envelope, breaking evolution = major) is treated like
        // memory being disabled: the companion continues memoryless. It
        // logs once per occurrence as a fixed metadata-only code — never
        // the version value, snippets, or any memory content.
        // I01-06 (additive): the fixed failure code rides to the kernel's
        // optional status sink so the run can surface `timeout`,
        // `version_mismatch`, `limit`, or `unavailable` — metadata only.
        const code: MemoryCliFailureCode =
          error instanceof MemoryCliError ? error.cliCode : "cli_unavailable";
        if (code === "cli_version_mismatch") {
          log("warn", "memory.version_mismatch");
        }
        onFailure?.(code);
        return [];
      }
      if (!envelope.ok) {
        onFailure?.("cli_malformed");
        return [];
      }
      const parsed = parseRecallData(envelope.data);
      if (parsed === null) {
        onFailure?.("cli_malformed");
        return [];
      }
      // F-I01-05: recall `vector` mode is metadata only (never a body).
      // Logged as a fixed closed-vocabulary status; never shown to the model.
      if (parsed.vector !== undefined) {
        log("info", "memory.recall_vector", { status: parsed.vector });
      }
      return parsed.items.map((item) => ({
        recordId: item.id,
        recallId: parsed.recallId,
        snippet: item.snippet,
        ...(item.kind !== undefined ? { kind: item.kind } : {}),
        ...(item.revision !== undefined ? { revision: item.revision } : {}),
        ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
        ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
      }));
    },
  };

  /* ---------------------------------------------------------------- */
  /* Explicit management: search / detail / staged mutations           */
  /* ---------------------------------------------------------------- */
  //
  // All four behaviors share one closed shape discipline:
  // - `record.search` is the ONLY explicit-search op (active+retired;
  //   archived/superseded excluded by remind itself). Search and detail
  //   NEVER call `record.feedback`: explicit search/open/mere UI display
  //   never heats, never reactivates, never grants.
  // - Handles are opaque session-scoped `mN` labels (`m1..mN` in CLI
  //   order) bound to exactly one (searchId, recordId) snapshot row.
  //   Raw canonical ids never cross the model/UI boundary; stored handles
  //   resolve server-side to source id + snapshot, and every mutation
  //   re-reads the CURRENT record before staging, rejecting
  //   superseded/stale targets. Historical snapshots are never rewritten
  //   (INSERT OR IGNORE) and never silently rebound to latest memory.
  // - Mutations stage through the narrow durable outbox only (this module
  //   never fakes a correction as remember/link, never retires via
  //   feedback, never physically deletes or transiently hides). A mutation
  //   binds a single explicit UI-selected target OR a uniquely resolved
  //   same-scope search target; multiple candidates without an explicit
  //   user selection return `needs_clarification` and stage NOTHING.

  /** Validate one explicit-search response item (fail-closed per item). */
  function parseSearchItems(data: Record<string, unknown> | null): {
    searchId: string;
    items: Array<{
      id: string;
      snippet: string;
      status: string;
      revision: number | null;
      createdAt?: string;
    }>;
  } | null {
    if (data === null || typeof data.searchId !== "string") {
      return null;
    }
    const searchId = data.searchId;
    if (
      searchId.length < 1 ||
      searchId.length > 256 ||
      hasControlCode(searchId)
    ) {
      return null;
    }
    const rawItems = data.items;
    if (!Array.isArray(rawItems)) {
      return null;
    }
    const items: Array<{
      id: string;
      snippet: string;
      status: string;
      revision: number | null;
      createdAt?: string;
    }> = [];
    for (const item of rawItems.slice(0, MEMORY_SEARCH_LIMIT_MAX)) {
      if (!isRecord(item)) {
        continue;
      }
      const { id, snippet, status, revision, createdAt } = item as {
        id?: unknown;
        snippet?: unknown;
        status?: unknown;
        revision?: unknown;
        createdAt?: unknown;
      };
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > 256 ||
        hasControlCode(id) ||
        typeof snippet !== "string" ||
        snippet.length < 1 ||
        countCodePoints(snippet) > 512 ||
        (status !== "active" && status !== "retired")
      ) {
        continue;
      }
      // Real per-record version snapshot when the CLI supplies it; null is
      // a valid unknown that later stages safely upgrade from the fresh
      // `record.get` (never guessed, never rebound silently).
      let snapshotRevision: number | null = null;
      if (revision !== undefined && revision !== null) {
        if (
          typeof revision !== "number" ||
          !Number.isInteger(revision) ||
          revision < 1 ||
          revision > 1_000_000
        ) {
          continue;
        }
        snapshotRevision = revision;
      }
      items.push({
        id,
        snippet,
        status,
        revision: snapshotRevision,
        ...(isCanonicalIsoInstant(createdAt) ? { createdAt } : {}),
      });
    }
    return { searchId, items };
  }

  /** Validate one `record.get` response record (closed shape, bounded). */
  function parseRecordDetail(data: Record<string, unknown> | null): {
    id: string;
    body: string;
    kind: string;
    status: string;
    revision: number;
    source: string;
    observedAt: string;
    createdAt: string;
    scope: string;
    evidence: string | null;
  } | null {
    if (data === null || !isRecord(data.record)) {
      return null;
    }
    const record = data.record as Record<string, unknown>;
    const { id, body, kind, status, revision, createdAt, scope, evidence } =
      record as {
        id?: unknown;
        body?: unknown;
        kind?: unknown;
        status?: unknown;
        revision?: unknown;
        createdAt?: unknown;
        scope?: unknown;
        evidence?: unknown;
      };
    const provenance = record.provenance as unknown;
    // Remind nests provenance as { source, observedAt } in remember/correct
    // but flattens get responses to `source`/`observedAt` top-level fields
    // (see live probe): accept both shapes, never reject a real record.
    let source: unknown;
    let observedAt: unknown;
    if (isRecord(provenance)) {
      source = provenance.source;
      observedAt = provenance.observedAt;
    } else {
      source = record.source;
      observedAt = record.observedAt;
    }
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 256 ||
      hasControlCode(id) ||
      typeof body !== "string" ||
      countCodePoints(body) < 1 ||
      countCodePoints(body) > MEMORY_EVENT_BODY_MAX_CP ||
      typeof kind !== "string" ||
      kind.length < 1 ||
      kind.length > 64 ||
      typeof status !== "string" ||
      typeof revision !== "number" ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      typeof source !== "string" ||
      source.length < 1 ||
      source.length > 512 ||
      typeof observedAt !== "string" ||
      observedAt.length < 1 ||
      observedAt.length > 128 ||
      typeof createdAt !== "string" ||
      createdAt.length < 1 ||
      typeof scope !== "string" ||
      scope.length < 1
    ) {
      return null;
    }
    return {
      id,
      body,
      kind,
      status,
      revision,
      source,
      observedAt,
      createdAt,
      scope,
      evidence: normalizeRecalledEvidence(evidence),
    };
  }

  function requestHashForManagement(parts: Record<string, unknown>): string {
    const digest = createHash("sha256")
      .update(`memory-manage:${JSON.stringify(parts)}`)
      .digest("hex");
    return digest;
  }

  function isUuidLike(value: string): boolean {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    );
  }

  /**
   * Resolve a management target server-side. Returns the bound snapshot
   * (fixed record id, never rebound) or a fail-closed outcome.
   *
   * Caller origin is server-known (`trustedSelection`): true ONLY for the
   * trusted USER UI selection path (HTTP route hardcodes it). The model
   * tool path always passes false (hardcoded in bootstrap, never derived
   * from model args — a model-controlled flag can never set trusted).
   * - Trusted UI: an exact `handle` binds that snapshot; a missing handle
   *   binds ONLY a single-candidate search, else `needs_clarification`.
   * - Model (untrusted): a missing handle binds ONLY a single-candidate
   *   search (with a fresh `record.get` validation by the caller); ANY
   *   multi-candidate search returns `needs_clarification` and stages
   *   NOTHING — even when the model supplied an explicit `m1`.
   */
  function resolveManagementTarget(
    sessionId: string,
    searchId: string,
    handle: string | undefined,
    trustedSelection: boolean,
  ):
    | { readonly bound: { recordId: string; status: string; snippet: string } }
    | {
        readonly refused: "needs_clarification" | "target_not_found";
        readonly candidates?: readonly MemorySearchHit[];
      } {
    let header: ReturnType<typeof repo.getMemorySearch>;
    try {
      header = repo.getMemorySearch(searchId);
    } catch {
      return { refused: "target_not_found" };
    }
    // Session binding: a handle is valid only within the session whose
    // search created it. Cross-session/scope smuggling fails closed with
    // the same fixed code (no existence oracle across sessions).
    if (header === null || header.sessionId !== sessionId) {
      return { refused: "target_not_found" };
    }
    if (header.scope !== scope) {
      return { refused: "target_not_found" };
    }
    let items: ReturnType<typeof repo.listMemorySearchItems>;
    try {
      items = repo.listMemorySearchItems(searchId);
    } catch {
      return { refused: "target_not_found" };
    }
    if (items.length === 0) {
      return { refused: "target_not_found" };
    }
    // Untrusted (model) origin: multi-candidate searches NEVER bind — not
    // even with an explicit model-supplied handle. The model must ask the
    // user for clarification; only an exactly-one-candidate search binds
    // (fresh-validated by the caller afterwards).
    if (!trustedSelection && items.length > 1) {
      return {
        refused: "needs_clarification",
        candidates: items.map((entry) => ({
          handle: entry.handle,
          snippet: entry.snippet,
          status: entry.status as "active" | "retired",
        })),
      };
    }
    if (handle !== undefined) {
      const item = items.find((entry) => entry.handle === handle) ?? null;
      if (item === null) {
        return { refused: "target_not_found" };
      }
      return {
        bound: {
          recordId: item.recordId,
          status: item.status,
          snippet: item.snippet,
        },
      };
    }
    if (items.length === 1 && items[0] !== undefined) {
      const only = items[0];
      return {
        bound: {
          recordId: only.recordId,
          status: only.status,
          snippet: only.snippet,
        },
      };
    }
    return {
      refused: "needs_clarification",
      candidates: items.map((entry) => ({
        handle: entry.handle,
        snippet: entry.snippet,
        status: entry.status as "active" | "retired",
      })),
    };
  }

  /** Fresh `record.get` before staging (rejects superseded/stale targets). */
  async function freshRecordForStaging(
    recordId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly current: NonNullable<ReturnType<typeof parseRecordDetail>> }
    | { readonly failed: "target_not_found" | "service_unavailable" }
  > {
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        "record.get",
        { id: recordId, scope },
        undefined,
        { ...(signal !== undefined ? { signal } : {}) },
      );
    } catch {
      return { failed: "service_unavailable" };
    }
    if (!envelope.ok) {
      // NOT_FOUND / FORBIDDEN_SCOPE / BAD_REQUEST: the target cannot be
      // managed (never guessed, never rebound). TIMEOUT/STORE_UNAVAILABLE
      // are transient: surface unavailable so the caller retries same-key.
      if (
        envelope.code === "TIMEOUT" ||
        envelope.code === "STORE_UNAVAILABLE"
      ) {
        return { failed: "service_unavailable" };
      }
      return { failed: "target_not_found" };
    }
    const parsed = parseRecordDetail(envelope.data);
    if (parsed === null || parsed.scope !== scope) {
      return { failed: "target_not_found" };
    }
    return { current: parsed };
  }

  async function searchMemories(input: {
    sessionId: string;
    runId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchResult> {
    throwIfStagingCancelled(input.signal);
    const trimmed = sliceCodePoints(
      input.query.trim(),
      MEMORY_SEARCH_QUERY_MAX_CP,
    );
    if (trimmed.length === 0) {
      throw new MemoryManageError("validation_error");
    }
    const limit =
      input.limit === undefined
        ? MEMORY_SEARCH_LIMIT_MAX
        : Math.trunc(input.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MEMORY_SEARCH_LIMIT_MAX
    ) {
      throw new MemoryManageError("validation_error");
    }
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        "record.search",
        {
          query: trimmed,
          scope,
          limit,
          runId: input.runId,
        },
        undefined,
        { ...(input.signal !== undefined ? { signal: input.signal } : {}) },
      );
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    throwIfStagingCancelled(input.signal);
    if (!envelope.ok) {
      throw new MemoryManageError(
        envelope.code === "TIMEOUT" || envelope.code === "STORE_UNAVAILABLE"
          ? "service_unavailable"
          : "validation_error",
      );
    }
    const parsed = parseSearchItems(envelope.data);
    if (parsed === null) {
      throw new MemoryManageError("service_unavailable");
    }
    // No heat, no reactivation, no feedback: the search response is
    // persisted as an IMMUTABLE snapshot only (INSERT OR IGNORE keeps the
    // first rows on replay), carrying the REAL per-record version/status
    // snapshot when the CLI supplies it (nullable unknown otherwise).
    // Handles are deterministic `m1..mN` in CLI order, scoped to this
    // (sessionId, searchId); raw canonical ids stay server-side and never
    // cross the model/UI boundary.
    const hits: MemorySearchHit[] = parsed.items.map((item, index) => ({
      handle: `m${index + 1}`,
      snippet: item.snippet,
      status: item.status as "active" | "retired",
      ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    }));
    try {
      throwIfStagingCancelled(input.signal);
      repo.recordMemorySearch(
        {
          searchId: parsed.searchId,
          sessionId: input.sessionId,
          runId: input.runId,
          scope,
          query: trimmed,
          items: parsed.items.map((item, index) => ({
            handle: `m${index + 1}`,
            recordId: item.id,
            revision: item.revision,
            status: item.status,
            snippet: item.snippet,
          })),
        },
        { now: now() },
      );
    } catch (error) {
      if (error instanceof MemoryManageCancelled) {
        throw error;
      }
      throw new MemoryManageError("service_unavailable");
    }
    // Re-read the stored rows so a redelivered searchId returns the FIRST
    // (historical) snapshot, never a rebound rewrite. The stored rows are
    // authoritative: a length mismatch means the handles were NOT durably
    // persisted, so fail closed instead of returning live fallback handles
    // that would not resolve. Every returned handle MUST resolve afterwards.
    let stored: ReturnType<typeof repo.listMemorySearchItems>;
    try {
      stored = repo.listMemorySearchItems(parsed.searchId);
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    // Snapshot-ownership check: a redelivered searchId for another session,
    // run, scope, or query must NEVER return the first owner's rows (the
    // count can coincidentally match). Fail closed with the same fixed
    // code instead of leaking another owner's snippets.
    let header: ReturnType<typeof repo.getMemorySearch>;
    try {
      header = repo.getMemorySearch(parsed.searchId);
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    if (
      header === null ||
      header.sessionId !== input.sessionId ||
      header.runId !== input.runId ||
      header.scope !== scope ||
      header.query !== trimmed
    ) {
      throw new MemoryManageError("service_unavailable");
    }
    throwIfStagingCancelled(input.signal);
    if (stored.length !== hits.length) {
      throw new MemoryManageError("service_unavailable");
    }
    return {
      searchId: parsed.searchId,
      hits: stored.map((entry) => ({
        handle: entry.handle,
        snippet: entry.snippet,
        status: entry.status as "active" | "retired",
      })),
    };
  }

  /** One validated `record.list` row: metadata only (snippet is discarded). */
  interface StatsListRow {
    readonly kind: string;
    readonly status: string;
    readonly createdAt: string;
  }

  function parseStatsRows(
    data: Record<string, unknown> | null,
  ): StatsListRow[] | null {
    if (!isRecord(data) || !Array.isArray(data.items)) return null;
    const rows: StatsListRow[] = [];
    for (const raw of data.items) {
      if (
        !isRecord(raw) ||
        typeof raw.kind !== "string" ||
        typeof raw.status !== "string" ||
        typeof raw.createdAt !== "string" ||
        !Number.isFinite(Date.parse(raw.createdAt))
      ) {
        return null;
      }
      rows.push({
        kind: raw.kind,
        status: raw.status,
        createdAt: raw.createdAt,
      });
    }
    return rows;
  }

  /**
   * One newest-first page of `record.list`. remind has no cursor, so the
   * caller pages backward with `until` (exclusive). A rejected page limit
   * (config `limits.limitMax`) is retried once at each smaller candidate;
   * the accepted size is reused for the rest of this process.
   */
  async function listStatsPage(
    status: string,
    until: string | null,
    since: string | null = null,
  ): Promise<{ rows: StatsListRow[]; limit: number }> {
    for (;;) {
      const limit =
        MEMORY_STATS_PAGE_LIMIT_CANDIDATES[statsPageLimitIndex] ?? 1;
      let envelope: MemoryCliEnvelope;
      try {
        envelope = await cliCall(
          address,
          "record.list",
          {
            scope,
            status,
            limit,
            ...(since !== null ? { since } : {}),
            ...(until !== null ? { until } : {}),
          },
          undefined,
        );
      } catch {
        throw new MemoryManageError("service_unavailable");
      }
      if (envelope.ok) {
        const rows = parseStatsRows(envelope.data);
        if (rows === null) {
          throw new MemoryManageError("service_unavailable");
        }
        return { rows, limit };
      }
      if (
        envelope.code === "LIMIT_EXCEEDED" &&
        statsPageLimitIndex < MEMORY_STATS_PAGE_LIMIT_CANDIDATES.length - 1
      ) {
        statsPageLimitIndex += 1;
        continue;
      }
      throw new MemoryManageError("service_unavailable");
    }
  }

  /** Walk one status newest -> oldest, stopping at the fixed row cap. */
  async function walkStatsStatus(
    status: string,
    rowCap: number,
  ): Promise<{ rows: StatsListRow[]; truncated: boolean }> {
    const rows: StatsListRow[] = [];
    let until: string | null = null;
    for (;;) {
      throwIfStagingCancelled();
      const page = await listStatsPage(status, until);
      if (page.rows.length < page.limit) {
        rows.push(...page.rows);
        return { rows, truncated: false };
      }
      if (rows.length >= rowCap) {
        // A full page means older rows may remain; the cap already holds.
        return { rows, truncated: true };
      }
      const oldest = page.rows[page.rows.length - 1];
      if (oldest === undefined) {
        return { rows, truncated: false };
      }
      // Production writes several records with the SAME createdAt (one
      // extraction event -> multiple memories). A full page can end inside
      // such a group, so counting only the rows newer than the oldest
      // timestamp and re-reading the whole group avoids skipping the rest
      // of it on the next (strictly older) `until` page.
      const t = oldest.createdAt;
      const tMs = Date.parse(t);
      for (const row of page.rows) {
        if (Date.parse(row.createdAt) > tMs) rows.push(row);
      }
      if (rows.length >= rowCap) {
        return { rows, truncated: true };
      }
      // `since` is inclusive and `until` exclusive in remind, so this
      // fetches exactly the t-group. If the group itself fills a page there
      // is no timestamp cursor to page within it: count what came back and
      // mark the snapshot truncated rather than silently undercount.
      const group = await listStatsPage(
        status,
        new Date(tMs + 1).toISOString(),
        new Date(tMs).toISOString(),
      );
      rows.push(...group.rows);
      if (group.rows.length >= group.limit || rows.length >= rowCap) {
        return { rows, truncated: true };
      }
      until = new Date(tMs).toISOString();
    }
  }

  /** Fixed `record.stats` bucket upper bounds (last is exclusive top). */
  const STATS_IMPORTANCE_LT: readonly number[] = [0.2, 0.4, 0.6, 0.8, 1.0001];

  function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): boolean {
    const keys = Object.keys(value);
    return (
      keys.length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key))
    );
  }

  /**
   * Strict, bounded parse of one `record.stats` payload: exact top-level and
   * nested keys, non-negative integer counts, the configured scope, an ISO
   * `computedAt`, and the five fixed importance buckets. Anything else is
   * rejected (the service reports service_unavailable, never crashes).
   */
  function parseRecordStats(
    data: Record<string, unknown> | null,
  ): MemoryStats | null {
    if (
      !isRecord(data) ||
      !hasExactKeys(data, [
        "scope",
        "byKind",
        "byStatus",
        "importance",
        "computedAt",
      ]) ||
      data.scope !== scope ||
      typeof data.computedAt !== "string"
    ) {
      return null;
    }
    const computedAt = Date.parse(data.computedAt);
    if (!Number.isSafeInteger(computedAt) || computedAt < 0) return null;
    const rawKind = data.byKind;
    const rawStatus = data.byStatus;
    if (
      !isRecord(rawKind) ||
      !hasExactKeys(rawKind, [
        "user_fact",
        "model_inference",
        "summary",
        "correction",
      ]) ||
      !isRecord(rawStatus) ||
      !hasExactKeys(rawStatus, ["active", "retired", "superseded", "archived"])
    ) {
      return null;
    }
    const kindKeys = [
      "user_fact",
      "model_inference",
      "summary",
      "correction",
    ] as const;
    const statusKeys = ["active", "retired", "superseded", "archived"] as const;
    const byKind = {} as Record<(typeof kindKeys)[number], number>;
    for (const key of kindKeys) {
      const count = rawKind[key];
      if (!isNonNegativeInteger(count)) return null;
      byKind[key] = count;
    }
    const byStatus = {} as Record<(typeof statusKeys)[number], number>;
    for (const key of statusKeys) {
      const count = rawStatus[key];
      if (!isNonNegativeInteger(count)) return null;
      byStatus[key] = count;
    }
    const rawImportance = data.importance;
    if (
      !isRecord(rawImportance) ||
      !hasExactKeys(rawImportance, ["scored", "unscored", "buckets"]) ||
      !isNonNegativeInteger(rawImportance.scored) ||
      !isNonNegativeInteger(rawImportance.unscored) ||
      !Array.isArray(rawImportance.buckets) ||
      rawImportance.buckets.length !== STATS_IMPORTANCE_LT.length
    ) {
      return null;
    }
    const buckets: MemoryStatsImportanceBucket[] = [];
    for (let index = 0; index < STATS_IMPORTANCE_LT.length; index += 1) {
      const raw = rawImportance.buckets[index];
      if (
        !isRecord(raw) ||
        !hasExactKeys(raw, ["lt", "count"]) ||
        raw.lt !== STATS_IMPORTANCE_LT[index] ||
        !isNonNegativeInteger(raw.count)
      ) {
        return null;
      }
      buckets.push({ lt: raw.lt as number, count: raw.count });
    }
    return {
      byKind,
      byStatus,
      importance: {
        scored: rawImportance.scored,
        unscored: rawImportance.unscored,
        buckets,
      },
      computedAt,
      // `record.stats` is a complete single-transaction aggregate.
      truncated: false,
    };
  }

  async function collectMemoryStats(): Promise<MemoryStats> {
    throwIfStagingCancelled();
    if (!statsUnsupported) {
      let envelope: MemoryCliEnvelope;
      try {
        envelope = await cliCall(address, "record.stats", { scope }, undefined);
      } catch {
        // Transport failure is NOT an unsupported op: report it instead of
        // silently switching to the expensive fallback.
        throw new MemoryManageError("service_unavailable");
      }
      if (envelope.ok) {
        const parsed = parseRecordStats(envelope.data);
        if (parsed === null) {
          throw new MemoryManageError("service_unavailable");
        }
        return parsed;
      }
      if (envelope.code !== "BAD_REQUEST") {
        throw new MemoryManageError("service_unavailable");
      }
      // Older remind: unknown op -> BAD_REQUEST. Latch for this process so
      // later cache misses never retry the unsupported call.
      statsUnsupported = true;
    }
    const computedAt = now();
    // Statuses are independent reads; each is bounded by its row cap.
    const active = await walkStatsStatus("active", MEMORY_STATS_ACTIVE_ROW_CAP);
    const retired = await walkStatsStatus(
      "retired",
      MEMORY_STATS_STATUS_ROW_CAP,
    );
    const superseded = await walkStatsStatus(
      "superseded",
      MEMORY_STATS_STATUS_ROW_CAP,
    );
    const archived = await walkStatsStatus(
      "archived",
      MEMORY_STATS_STATUS_ROW_CAP,
    );
    throwIfStagingCancelled();
    const byKind = {
      user_fact: 0,
      model_inference: 0,
      summary: 0,
      correction: 0,
    };
    for (const row of active.rows) {
      if (row.status !== "active") continue;
      if (
        row.kind === "user_fact" ||
        row.kind === "model_inference" ||
        row.kind === "summary" ||
        row.kind === "correction"
      ) {
        byKind[row.kind] += 1;
      }
    }
    return {
      byKind,
      byStatus: {
        active: active.rows.length,
        retired: retired.rows.length,
        superseded: superseded.rows.length,
        archived: archived.rows.length,
      },
      computedAt,
      truncated:
        active.truncated ||
        retired.truncated ||
        superseded.truncated ||
        archived.truncated,
    };
  }

  async function collectAndCacheMemoryStats(): Promise<MemoryStats> {
    throwIfStagingCancelled();
    const value = await collectMemoryStats();
    statsCache = { at: now(), value };
    return value;
  }

  function getMemoryStats(): Promise<MemoryStats> {
    throwIfStagingCancelled();
    const at = now();
    if (
      statsCache !== null &&
      at >= statsCache.at &&
      at - statsCache.at < MEMORY_STATS_CACHE_TTL_MS
    ) {
      return Promise.resolve(statsCache.value);
    }
    if (statsPending !== null) {
      return statsPending;
    }
    const pending = collectAndCacheMemoryStats();
    statsPending = pending;
    // Attach handlers so a rejection never becomes an unhandled rejection.
    pending.then(
      () => {
        if (statsPending === pending) statsPending = null;
      },
      () => {
        if (statsPending === pending) statsPending = null;
      },
    );
    return pending;
  }

  async function getMemoryDetail(input: {
    sessionId: string;
    searchId: string;
    handle: string;
  }): Promise<MemoryDetailResult> {
    // Confirmation detail is a trusted UI read: the exact selected handle
    // binds (multi-candidate searches keep every handle resolvable).
    const resolved = resolveManagementTarget(
      input.sessionId,
      input.searchId,
      input.handle,
      true,
    );
    if ("refused" in resolved) {
      throw new MemoryManageError("target_not_found");
    }
    const fresh = await freshRecordForStaging(resolved.bound.recordId);
    if ("failed" in fresh) {
      throw new MemoryManageError(fresh.failed);
    }
    // Confirmation UI: the cited snapshot (what was shown) stays DISTINCT
    // from the live current record. Opening/detail never heats or grants.
    return {
      snapshot: {
        searchId: input.searchId,
        handle: input.handle,
        snippet: resolved.bound.snippet,
        status: resolved.bound.status as "active" | "retired",
      },
      current: {
        body: fresh.current.body,
        kind: fresh.current.kind,
        status: fresh.current.status,
        revision: fresh.current.revision,
        source: fresh.current.source,
        observedAt: fresh.current.observedAt,
        createdAt: fresh.current.createdAt,
        evidence: fresh.current.evidence,
      },
      stale: resolved.bound.status !== fresh.current.status,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Conversation-memory graph (explicit read-only projection)        */
  /* ---------------------------------------------------------------- */

  function parseGraphVersion(
    data: Record<string, unknown> | null,
  ): string | null {
    if (data === null) {
      return null;
    }
    const version = data.version;
    // Real remind `graph.version` is an OPAQUE STRING token (e.g.
    // `o12:r40.7:a91:e3.2.2026-10-21...`). Companion must never parse its
    // internals: it only compares it for cache freshness and passes it
    // through. Malformed/oversized/control-bearing tokens fail closed.
    if (
      typeof version !== "string" ||
      version.length < 1 ||
      version.length > 256 ||
      hasControlCode(version)
    ) {
      return null;
    }
    return version;
  }

  function parseGraphEpisode(value: unknown): MemoryGraphEpisode | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (!isRecord(value)) {
      return null;
    }
    const { kind, episodeKey, level } = value as {
      kind?: unknown;
      episodeKey?: unknown;
      level?: unknown;
    };
    if (
      (kind !== "session" && kind !== "doc" && kind !== "day") ||
      typeof episodeKey !== "string" ||
      episodeKey.length < 1 ||
      episodeKey.length > 256 ||
      hasControlCode(episodeKey) ||
      (level !== "window" && level !== "episode")
    ) {
      // Episode provenance is optional metadata: an unknown shape is
      // dropped (never guessed), leaving the rest of the valid node intact.
      return null;
    }
    return { kind, episodeKey, level };
  }

  function parseRawGraphNode(value: unknown): RawGraphNode | null {
    if (!isRecord(value)) {
      return null;
    }
    const { id, label, status, kind } = value as {
      id?: unknown;
      label?: unknown;
      status?: unknown;
      kind?: unknown;
    };
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 256 ||
      hasControlCode(id) ||
      typeof label !== "string" ||
      label.length < 1 ||
      countCodePoints(label) > MEMORY_GRAPH_LABEL_MAX_CP ||
      (status !== "active" && status !== "retired") ||
      typeof kind !== "string" ||
      kind.length < 1 ||
      kind.length > 64 ||
      hasControlCode(kind)
    ) {
      return null;
    }
    return {
      id,
      label,
      status,
      kind,
      // Topics are additive metadata: invalid entries are dropped one by
      // one; an invalid/absent list leaves the node valid with no topics.
      topics: normalizeTopics((value as { topics?: unknown }).topics),
      // Created-at is display metadata only: a non-canonical value is
      // omitted rather than re-rendered (same rule as recall items).
      ...(isCanonicalIsoInstant((value as { createdAt?: unknown }).createdAt)
        ? { createdAt: (value as { createdAt: string }).createdAt }
        : {}),
      episode: parseGraphEpisode(value.episode),
    };
  }

  function parseRawGraphEdge(value: unknown): RawGraphEdge | null {
    if (!isRecord(value)) {
      return null;
    }
    const { from, to, kind } = value as {
      from?: unknown;
      to?: unknown;
      kind?: unknown;
    };
    if (
      typeof from !== "string" ||
      from.length < 1 ||
      from.length > 256 ||
      hasControlCode(from) ||
      typeof to !== "string" ||
      to.length < 1 ||
      to.length > 256 ||
      hasControlCode(to) ||
      (kind !== "related" && kind !== "consolidation" && kind !== "similar")
    ) {
      return null;
    }
    return { from, to, kind };
  }

  function dedupeRawGraphNodes(nodes: RawGraphNode[]): {
    nodes: RawGraphNode[];
    truncated: boolean;
  } {
    const out: RawGraphNode[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const node of nodes) {
      if (seen.has(node.id)) {
        continue;
      }
      if (out.length >= MEMORY_GRAPH_NODE_MAX) {
        truncated = true;
        break;
      }
      seen.add(node.id);
      out.push(node);
    }
    return { nodes: out, truncated };
  }

  function boundRawGraphEdges(
    edges: RawGraphEdge[],
    nodeIds: ReadonlySet<string>,
  ): { edges: RawGraphEdge[]; truncated: boolean } {
    const out: RawGraphEdge[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const edge of edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        continue;
      }
      // Similar edges are semantically undirected: dedupe the pair
      // regardless of which endpoint listed it (graph.page lists only the
      // smaller endpoint, local graph may emit either direction).
      const key =
        edge.kind === "similar"
          ? `similar\u0000${[edge.from, edge.to].sort().join("\u0000")}`
          : `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
      if (seen.has(key)) {
        continue;
      }
      if (out.length >= MEMORY_GRAPH_EDGE_MAX) {
        truncated = true;
        break;
      }
      seen.add(key);
      out.push(edge);
    }
    return { edges: out, truncated };
  }

  function parseGraphPage(data: Record<string, unknown> | null): {
    nodes: RawGraphNode[];
    edges: RawGraphEdge[];
    nextCursor: string | null;
    version: string;
  } | null {
    if (data === null || !Array.isArray(data.nodes)) {
      return null;
    }
    const version = parseGraphVersion(data);
    if (version === null) {
      return null;
    }
    const rawCursor = data.nextCursor;
    let nextCursor: string | null = null;
    if (rawCursor !== undefined && rawCursor !== null) {
      if (
        typeof rawCursor !== "string" ||
        rawCursor.length < 1 ||
        rawCursor.length > 512 ||
        hasControlCode(rawCursor)
      ) {
        return null;
      }
      nextCursor = rawCursor;
    }
    const nodes: RawGraphNode[] = [];
    const edges: RawGraphEdge[] = [];
    for (const value of data.nodes) {
      const node = parseRawGraphNode(value);
      if (node === null) {
        // Fail closed per node: one malformed node is skipped whole (it
        // never contributes a node or edges), the page still parses.
        continue;
      }
      nodes.push(node);
      const rawOut = isRecord(value) ? value.out : undefined;
      if (Array.isArray(rawOut)) {
        for (const out of rawOut) {
          // Real `graph.page` emits adjacency edges as `{to, kind}` (the
          // source is the containing node), never raw `{from,to}` pairs.
          const edge = parseRawGraphEdge(
            isRecord(out) ? { ...out, from: node.id } : out,
          );
          if (edge !== null) {
            edges.push(edge);
          }
        }
      }
    }
    return { nodes, edges, nextCursor, version };
  }

  function parseGraphLocal(data: Record<string, unknown> | null): {
    center: string | null;
    nodes: RawGraphNode[];
    edges: RawGraphEdge[];
    version: string;
    truncated: boolean;
  } | null {
    if (data === null || !Array.isArray(data.nodes)) {
      return null;
    }
    const version = parseGraphVersion(data);
    if (version === null) {
      return null;
    }
    let center: string | null = null;
    if (data.center !== undefined && data.center !== null) {
      if (
        typeof data.center !== "string" ||
        data.center.length < 1 ||
        data.center.length > 256 ||
        hasControlCode(data.center)
      ) {
        return null;
      }
      center = data.center;
    }
    const nodes: RawGraphNode[] = [];
    for (const value of data.nodes) {
      const node = parseRawGraphNode(value);
      if (node !== null) {
        nodes.push(node);
      }
    }
    const edges: RawGraphEdge[] = [];
    if (Array.isArray(data.edges)) {
      for (const value of data.edges) {
        const edge = parseRawGraphEdge(value);
        if (edge !== null) {
          edges.push(edge);
        }
      }
    }
    return {
      center,
      nodes,
      edges,
      version,
      truncated: data.truncated === true,
    };
  }

  async function callGraphCli(
    op: "graph.local" | "graph.page" | "graph.version",
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MemoryCliEnvelope> {
    try {
      return await cliCall(address, op, params, undefined, {
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
  }

  /**
   * Fixed graph failure mapping: an old remind that does not know the graph
   * ops answers BAD_REQUEST -> distinct `memory_graph_unavailable` (routes
   * render 503); transient store/timeout failures stay service_unavailable;
   * other local failures fail closed as target_not_found.
   */
  function graphFailure(
    envelope: MemoryCliEnvelope,
    fallback: "target_not_found" | "service_unavailable",
  ): never {
    if (envelope.code === "BAD_REQUEST") {
      throw new MemoryManageError("memory_graph_unavailable");
    }
    if (envelope.code === "TIMEOUT" || envelope.code === "STORE_UNAVAILABLE") {
      throw new MemoryManageError("service_unavailable");
    }
    throw new MemoryManageError(fallback);
  }

  async function fetchGlobalGraph(input: {
    includeRetired: boolean;
    signal?: AbortSignal;
  }): Promise<{
    version: string;
    nodes: RawGraphNode[];
    edges: RawGraphEdge[];
    truncated: boolean;
  }> {
    const versionEnvelope = await callGraphCli(
      "graph.version",
      { scope },
      input.signal,
    );
    if (!versionEnvelope.ok) {
      graphFailure(versionEnvelope, "service_unavailable");
    }
    const version = parseGraphVersion(versionEnvelope.data);
    if (version === null) {
      throw new MemoryManageError("service_unavailable");
    }
    const cacheKey = `${scope}\u0000${input.includeRetired ? "1" : "0"}`;
    const cached = graphCache.get(cacheKey);
    if (cached !== undefined && cached.version === version) {
      return cached;
    }

    const nodes: RawGraphNode[] = [];
    const rawEdges: RawGraphEdge[] = [];
    const nodeIds = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    let pages = 0;
    for (;;) {
      throwIfStagingCancelled(input.signal);
      pages += 1;
      if (pages > MEMORY_GRAPH_PAGE_MAX) {
        throw new MemoryManageError("service_unavailable");
      }
      const params: Record<string, unknown> = {
        scope,
        includeRetired: input.includeRetired,
        limit: graphPageLimit,
      };
      if (cursor !== undefined) {
        params.cursor = cursor;
      }
      const envelope = await callGraphCli("graph.page", params, input.signal);
      if (!envelope.ok) {
        graphFailure(envelope, "service_unavailable");
      }
      const page = parseGraphPage(envelope.data);
      if (page === null || page.version !== version) {
        throw new MemoryManageError("service_unavailable");
      }
      for (const node of page.nodes) {
        if (nodeIds.has(node.id)) {
          continue;
        }
        if (nodes.length >= MEMORY_GRAPH_NODE_MAX) {
          truncated = true;
          break;
        }
        nodeIds.add(node.id);
        nodes.push(node);
      }
      rawEdges.push(...page.edges);
      if (truncated) {
        break;
      }
      if (nodes.length >= MEMORY_GRAPH_NODE_MAX) {
        if (page.nextCursor !== null) {
          truncated = true;
        }
        break;
      }
      if (page.nextCursor === null) {
        break;
      }
      if (page.nextCursor === cursor) {
        throw new MemoryManageError("service_unavailable");
      }
      cursor = page.nextCursor;
    }
    throwIfStagingCancelled(input.signal);
    const boundedEdges = boundRawGraphEdges(rawEdges, nodeIds);
    truncated = truncated || boundedEdges.truncated;
    const entry = {
      version,
      nodes,
      edges: boundedEdges.edges,
      truncated,
    };
    graphCache.set(cacheKey, entry);
    return entry;
  }

  function mintGraphProjection(input: {
    sessionId: string;
    runId: string;
    scope: "global" | "local";
    version: string;
    center: string | null;
    nodes: RawGraphNode[];
    edges: RawGraphEdge[];
    truncated: boolean;
  }): MemoryGraphResult {
    let searchId: string;
    let minted: ReturnType<typeof repo.mintMemoryGraphItems>;
    try {
      searchId = repo.getOrCreateMemoryGraphSearch(
        {
          searchId: randomUUID(),
          sessionId: input.sessionId,
          runId: input.runId,
          scope,
        },
        { now: now() },
      );
      minted = repo.mintMemoryGraphItems(
        {
          searchId,
          items: input.nodes.map((node) => ({
            recordId: node.id,
            status: node.status,
            snippet: node.label,
          })),
        },
        { now: now() },
      );
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    const handleByRecordId = new Map<string, string>();
    for (const item of minted) {
      handleByRecordId.set(item.recordId, item.handle);
    }
    const nodes: MemoryGraphNodeResult[] = input.nodes.map((node, index) => {
      const mintedItem = minted[index];
      const handle = mintedItem?.handle ?? handleByRecordId.get(node.id) ?? "";
      return {
        handle,
        label: node.label,
        status: node.status,
        kind: node.kind,
        ...(node.topics.length > 0 ? { topics: node.topics } : {}),
        ...(node.createdAt !== undefined ? { createdAt: node.createdAt } : {}),
        episode: node.episode,
      };
    });
    const edges: MemoryGraphEdgeResult[] = [];
    for (const edge of input.edges) {
      const from = handleByRecordId.get(edge.from);
      const to = handleByRecordId.get(edge.to);
      if (from === undefined || to === undefined) {
        continue;
      }
      edges.push({ from, to, kind: edge.kind });
    }
    const center =
      input.center === null
        ? null
        : (handleByRecordId.get(input.center) ?? null);
    return {
      searchId,
      version: input.version,
      scope: input.scope,
      center,
      nodes,
      edges: edges.slice(0, MEMORY_GRAPH_EDGE_MAX),
      truncated: input.truncated,
    };
  }

  async function getMemoryGraphGlobal(
    sessionId: string,
    input: {
      includeRetired?: boolean;
      runId: string;
      signal?: AbortSignal;
    },
  ): Promise<MemoryGraphResult> {
    return trackGraphRead(input.signal, async (signal) => {
      const raw = await fetchGlobalGraph({
        includeRetired: input.includeRetired === true,
        signal,
      });
      throwIfStagingCancelled(signal);
      return mintGraphProjection({
        sessionId,
        runId: input.runId,
        scope: "global",
        version: raw.version,
        center: null,
        nodes: raw.nodes,
        edges: raw.edges,
        truncated: raw.truncated,
      });
    });
  }

  async function getMemoryGraphLocal(
    sessionId: string,
    input: {
      searchId: string;
      handle: string;
      depth?: 1 | 2;
      runId: string;
      signal?: AbortSignal;
    },
  ): Promise<MemoryGraphResult> {
    const depth = input.depth ?? 1;
    if (depth !== 1 && depth !== 2) {
      throw new MemoryManageError("validation_error");
    }
    return trackGraphRead(input.signal, async (signal) => {
      throwIfStagingCancelled(signal);
      // Resolve through the SAME session-bound snapshot path as detail:
      // a handle is valid only in the session whose search created it, and
      // the record id is the historical snapshot target (never rebound).
      const resolved = resolveManagementTarget(
        sessionId,
        input.searchId,
        input.handle,
        true,
      );
      if ("refused" in resolved) {
        throw new MemoryManageError("target_not_found");
      }
      const envelope = await callGraphCli(
        "graph.local",
        { scope, id: resolved.bound.recordId, depth },
        signal,
      );
      if (!envelope.ok) {
        graphFailure(envelope, "target_not_found");
      }
      const parsed = parseGraphLocal(envelope.data);
      if (parsed === null) {
        throw new MemoryManageError("service_unavailable");
      }
      const bounded = dedupeRawGraphNodes(parsed.nodes);
      const nodeIds = new Set(bounded.nodes.map((node) => node.id));
      const boundedEdges = boundRawGraphEdges(parsed.edges, nodeIds);
      throwIfStagingCancelled(signal);
      return mintGraphProjection({
        sessionId,
        runId: input.runId,
        scope: "local",
        version: parsed.version,
        center: parsed.center,
        nodes: bounded.nodes,
        edges: boundedEdges.edges,
        truncated:
          parsed.truncated || bounded.truncated || boundedEdges.truncated,
      });
    });
  }

  /**
   * Shared request-identity prefix for staging AND draining replays: body
   * validation + trusted snapshot resolution + the immutable request hash
   * (session/scope/action/target/body, no mutable live fields). The
   * draining path reuses this exact computation so a same-key request with
   * drifted content is a 409 there too, never a silent "deduplicated"
   * replay of a different mutation.
   */
  function resolveStagingIdentity(input: {
    kind: "record.correct" | "record.retire" | "record.reactivate";
    sessionId: string;
    searchId: string;
    handle?: string;
    correctionBody?: string;
    trustedSelection?: boolean;
  }):
    | {
        readonly ok: true;
        readonly recordId: string;
        readonly requestHash: string;
      }
    | {
        readonly ok: false;
        readonly code:
          | "validation_error"
          | "needs_clarification"
          | "target_not_found";
        readonly candidates?: readonly MemorySearchHit[];
      } {
    if (
      input.kind === "record.correct" &&
      (input.correctionBody === undefined ||
        countCodePoints(input.correctionBody) < 1 ||
        countCodePoints(input.correctionBody) > MEMORY_CORRECTION_BODY_MAX_CP)
    ) {
      return { ok: false, code: "validation_error" };
    }
    if (input.kind !== "record.correct" && input.correctionBody !== undefined) {
      return { ok: false, code: "validation_error" };
    }
    const resolved = resolveManagementTarget(
      input.sessionId,
      input.searchId,
      input.handle,
      input.trustedSelection === true,
    );
    if ("refused" in resolved) {
      return resolved.refused === "needs_clarification"
        ? {
            ok: false,
            code: "needs_clarification",
            candidates: resolved.candidates ?? [],
          }
        : { ok: false, code: "target_not_found" };
    }
    const reasonCode =
      input.kind === "record.retire"
        ? MEMORY_RETIRE_REASON
        : input.kind === "record.reactivate"
          ? MEMORY_REACTIVATE_REASON
          : undefined;
    return {
      ok: true,
      recordId: resolved.bound.recordId,
      requestHash: requestHashForManagement({
        kind: input.kind,
        sessionId: input.sessionId,
        scope,
        recordId: resolved.bound.recordId,
        ...(input.correctionBody !== undefined
          ? { body: input.correctionBody }
          : {}),
        ...(reasonCode !== undefined ? { reasonCode } : {}),
      }),
    };
  }

  async function stageMemoryMutation(input: {
    sessionId: string;
    runId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    searchId: string;
    handle?: string;
    correctionBody?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    trustedSelection?: boolean;
  }): Promise<MemoryStageOutcome> {
    const trusted = input.trustedSelection === true;
    pendingStagings += 1;
    try {
      throwIfStagingCancelled(input.signal);
      if (!isUuidLike(input.idempotencyKey)) {
        return { ok: false, code: "validation_error" };
      }
      const key = input.idempotencyKey.toLowerCase();
      const identity = resolveStagingIdentity({
        kind: input.kind,
        sessionId: input.sessionId,
        searchId: input.searchId,
        ...(input.handle !== undefined ? { handle: input.handle } : {}),
        ...(input.correctionBody !== undefined
          ? { correctionBody: input.correctionBody }
          : {}),
        trustedSelection: trusted,
      });
      if (!identity.ok) {
        return identity.code === "needs_clarification"
          ? {
              ok: false,
              code: identity.code,
              candidates: identity.candidates ?? [],
            }
          : { ok: false, code: identity.code };
      }
      // Immutable request identity (session/scope/action/target/body — NO
      // mutable live fields such as the fresh revision): the same key with
      // the same body replays the ORIGINAL stored status even after the
      // target state moved on; a drifted body is a 409. This lookup runs
      // BEFORE the live `record.get` + actionability gate so an exact
      // replay after a successful correct can never fail as superseded.
      const requestHash = identity.requestHash;
      try {
        const existing = repo.getMemoryOperationByKey(key);
        if (existing !== null) {
          if (existing.requestHash !== requestHash) {
            return { ok: false, code: "idempotency_conflict" };
          }
          if (
            existing.sessionId !== input.sessionId ||
            existing.kind !== input.kind ||
            existing.recordId !== identity.recordId
          ) {
            return { ok: false, code: "idempotency_conflict" };
          }
          return {
            ok: true,
            operationId: existing.id,
            status: existing.status,
            deduplicated: true,
          };
        }
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
      // Live freshness gate AFTER the replay lookup: the fresh `record.get`
      // (with the caller's AbortSignal forwarded) rejects superseded/stale
      // targets for NEW keys only; replays above already returned.
      let fresh: Awaited<ReturnType<typeof freshRecordForStaging>>;
      try {
        fresh = await freshRecordForStaging(identity.recordId, input.signal);
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
      // Cooperative cancellation: recheck aborted/stopped immediately after
      // the awaited read and again right before the atomic stage — never
      // stage post-stop or post-abort work.
      try {
        throwIfStagingCancelled(input.signal);
      } catch {
        throw new MemoryManageCancelled();
      }
      if ("failed" in fresh) {
        return { ok: false, code: fresh.failed };
      }
      const current = fresh.current;
      // Authoritative run recheck for the model (untrusted) path: the
      // staging run must still exist in this session after the awaited
      // read; a vanished/foreign run fails closed with no staging.
      try {
        const stagingRun = repo.getRun(input.runId);
        if (stagingRun.sessionId !== input.sessionId) {
          return { ok: false, code: "target_not_found" };
        }
        if (!trusted) {
          const status = stagingRun.status;
          if (
            status !== "queued" &&
            status !== "running" &&
            status !== "cancel_requested" &&
            status !== "completed"
          ) {
            throw new MemoryManageCancelled();
          }
        }
      } catch (error) {
        if (error instanceof MemoryManageCancelled) {
          throw error;
        }
        return { ok: false, code: "target_not_found" };
      }
      // Actionable-state gate (fresh read, never the snapshot): corrections
      // require a live `active` record (a retired/superseded/archived base is
      // a state conflict, never silently rebound); retire requires `active`
      // (already-retired replays stay idempotent through the CLI); reactivate
      // requires `retired` (already-active replays stay idempotent).
      if (input.kind === "record.correct" && current.status !== "active") {
        return { ok: false, code: "state_conflict" };
      }
      if (
        input.kind === "record.retire" &&
        current.status !== "active" &&
        current.status !== "retired"
      ) {
        return { ok: false, code: "state_conflict" };
      }
      if (
        input.kind === "record.reactivate" &&
        current.status !== "retired" &&
        current.status !== "active"
      ) {
        return { ok: false, code: "state_conflict" };
      }
      // Final pre-stage gate: no post-stop/post-abort writes — the atomic
      // repository stage below is synchronous, so this check stands
      // immediately before it.
      try {
        throwIfStagingCancelled(input.signal);
      } catch {
        throw new MemoryManageCancelled();
      }
      const at = now();
      try {
        if (input.kind === "record.correct") {
          return await stageCorrection({
            sessionId: input.sessionId,
            runId: input.runId,
            recordId: identity.recordId,
            body: input.correctionBody as string,
            revision: current.revision,
            key,
            requestHash,
            searchId: input.searchId,
            handle: input.handle ?? null,
            at,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          });
        }
        const reasonCode =
          input.kind === "record.retire"
            ? MEMORY_RETIRE_REASON
            : MEMORY_REACTIVATE_REASON;
        const jobKey =
          input.kind === "record.retire"
            ? stableMemoryJobKey("retire", key)
            : stableMemoryJobKey("reactivate", key);
        const params =
          input.kind === "record.retire"
            ? { id: identity.recordId, scope, reasonCode }
            : { id: identity.recordId, scope, reasonCode };
        const requestJson = JSON.stringify({ op: input.kind, params });
        const staged = repo.stageMemoryMutationAtomic(
          {
            jobKind: input.kind,
            jobSessionId: input.sessionId,
            jobRunId: input.runId,
            jobScope: scope,
            jobKey,
            requestJson,
            operation: {
              kind: input.kind,
              sessionId: input.sessionId,
              runId: input.runId,
              searchId: input.searchId,
              handle: input.handle ?? null,
              recordId: identity.recordId,
              revision: current.revision,
              idempotencyKey: key,
              requestHash,
            },
          },
          { now: at },
        );
        return {
          ok: true,
          operationId: staged.operation.id,
          status: staged.operation.status,
          deduplicated: staged.deduplicated,
        };
      } catch (error) {
        if (error instanceof MemoryManageCancelled) {
          throw error;
        }
        // IdempotencyConflictError carries request-specific state, so detect
        // by its fixed class name (no values): same key + drifted body, or
        // a preexisting outbox payload with a different body.
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { name?: unknown }).name === "IdempotencyConflictError"
        ) {
          return { ok: false, code: "idempotency_conflict" };
        }
        return { ok: false, code: "service_unavailable" };
      }
    } finally {
      pendingStagings -= 1;
    }
  }

  /**
   * Stage a correction as a NEW raw source event first (the user's actual
   * replacement, stable provenance + stable event id), chained to the real
   * `record.correct`. The operation row starts bound to the event job and
   * is rebound to the correct job when the event acks.
   */
  async function stageCorrection(input: {
    sessionId: string;
    runId: string;
    recordId: string;
    body: string;
    revision: number;
    key: string;
    requestHash: string;
    searchId: string;
    handle: string | null;
    at: number;
    signal?: AbortSignal;
  }): Promise<MemoryStageOutcome> {
    throwIfStagingCancelled(input.signal);
    let turnId: string;
    try {
      const run = repo.getRun(input.runId);
      if (run.sessionId !== input.sessionId) {
        return { ok: false, code: "target_not_found" };
      }
      turnId = run.turnId;
    } catch {
      return { ok: false, code: "target_not_found" };
    }
    const compactKey = input.key.replace(/-/g, "");
    const sourceEventId = `evt-${compactKey}`;
    const eventJobKey = stableMemoryJobKey("correct-event", input.key);
    const correctJobKey = stableMemoryJobKey("correct", input.key);
    const observedAt = new Date(input.at).toISOString();
    const provenance = {
      source: MEMORY_PROVENANCE_SOURCE,
      observedAt,
    };
    const eventBody = sliceCodePoints(input.body, MEMORY_EVENT_BODY_MAX_CP);
    try {
      throwIfStagingCancelled(input.signal);
      // Single atomic transaction: the source event job + the operation
      // row commit together with payload-identity validation, so a crash
      // can never leave a runnable write with no operation, and a drifted
      // retry can never bind a new-body operation to an old payload.
      const staged = repo.stageMemoryMutationAtomic(
        {
          jobKind: "event.append",
          jobSessionId: input.sessionId,
          jobRunId: input.runId,
          jobScope: scope,
          jobKey: eventJobKey,
          requestJson: JSON.stringify({
            op: "event.append",
            params: {
              eventId: sourceEventId,
              sessionId: input.sessionId,
              turnId,
              body: eventBody,
              provenance,
              privacy: {
                sensitivity: MEMORY_PRIVACY_SENSITIVITY_NORMAL,
                origin: MEMORY_PRIVACY_ORIGIN_CONVERSATION,
              },
              scope,
              runId: input.runId,
            },
            chain: {
              correct: {
                recordId: input.recordId,
                body: input.body,
                provenance,
                sourceEventId,
                correctJobKey,
                clientKey: input.key,
                sessionId: input.sessionId,
                runId: input.runId,
                turnId,
              },
            },
          }),
          jobTurnId: turnId,
          operation: {
            kind: "record.correct",
            sessionId: input.sessionId,
            runId: input.runId,
            searchId: input.searchId,
            handle: input.handle,
            recordId: input.recordId,
            revision: input.revision,
            idempotencyKey: input.key,
            requestHash: input.requestHash,
          },
        },
        { now: input.at },
      );
      return {
        ok: true,
        operationId: staged.operation.id,
        status: staged.operation.status,
        deduplicated: staged.deduplicated,
      };
    } catch (error) {
      if (error instanceof MemoryManageCancelled) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "IdempotencyConflictError"
      ) {
        return { ok: false, code: "idempotency_conflict" };
      }
      return { ok: false, code: "service_unavailable" };
    }
  }

  function getMemoryOperation(
    sessionId: string,
    operationId: string,
  ): MemoryOperationStatus | null {
    let row: ReturnType<typeof repo.getMemoryOperation>;
    try {
      row = repo.getMemoryOperation(operationId);
    } catch {
      return null;
    }
    if (row === null || row.sessionId !== sessionId) {
      return null;
    }
    return {
      operationId: row.id,
      kind: row.kind,
      recordRevision: row.revision,
      status: row.status,
    };
  }

  /**
   * Per-run recall exposure for answer citations (`mN`): the exact snippet
   * the model saw during ONE run. Session-bound (the exposure's session
   * must match the request); cross-run/cross-session citations resolve to
   * null so the UI fails closed instead of opening an unrelated explicit
   * search's snapshot. Raw record/recall ids never leave this boundary.
   */
  function getMemoryRecallExposure(input: {
    sessionId: string;
    runId: string;
    citation: string;
  }): {
    runId: string;
    citation: string;
    snippet: string;
    revision: number | null;
    kind: "user_fact" | "model_inference" | "summary" | "correction" | null;
  } | null {
    if (!/^m[1-9][0-9]*$/.test(input.citation)) {
      return null;
    }
    let exposures: ReturnType<typeof repo.listMemoryExposures>;
    try {
      exposures = repo.listMemoryExposures(input.runId);
    } catch {
      return null;
    }
    const match = exposures.find(
      (entry) =>
        entry.citation === input.citation &&
        entry.sessionId === input.sessionId,
    );
    if (match === undefined) {
      return null;
    }
    return {
      runId: input.runId,
      citation: match.citation,
      snippet: match.snippet,
      // I04: provenance pinned at exposure time — a later correction is a
      // new revision and never rewrites this cited snapshot.
      revision: match.revision,
      kind: match.kind,
    };
  }

  /**
   * Draining replay identity for one stored idempotency key: recompute the
   * immutable request hash for the incoming (kind/body/target) with NO
   * live read and NO staging, so the route replays only an exact match and
   * answers 409 `idempotency_key_reused` on drifted content. Null when the
   * request cannot be verified (validation/target failure): the route
   * falls back to 503 without persisting anything.
   */
  function hashDrainingReplay(input: {
    kind: "record.correct" | "record.retire" | "record.reactivate";
    sessionId: string;
    searchId: string;
    handle?: string;
    correctionBody?: string;
  }): { requestHash: string; recordId: string } | null {
    try {
      const identity = resolveStagingIdentity({
        kind: input.kind,
        sessionId: input.sessionId,
        searchId: input.searchId,
        ...(input.handle !== undefined ? { handle: input.handle } : {}),
        ...(input.correctionBody !== undefined
          ? { correctionBody: input.correctionBody }
          : {}),
        trustedSelection: true,
      });
      if (!identity.ok) {
        return null;
      }
      return {
        requestHash: identity.requestHash,
        recordId: identity.recordId,
      };
    } catch {
      return null;
    }
  }

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    // Crash recovery: drain jobs left pending by an interrupted process
    // with the same stable keys (remind dedups replays, no duplicates).
    void drainOnce()
      .catch(() => undefined)
      .finally(() => {
        armIdleTimer();
      });
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    // No new background admissions from here (STOP/shutdown preemption is
    // precise: OUR OWN calls abort; foreground recall/search/stage paths
    // were never gated and stay usable until this stop lands).
    try {
      background?.close();
    } catch {
      // Best effort.
    }
    // Abort OUR OWN in-flight extraction calls (never the global gateway):
    // a parked extraction socket closes here instead of running to its own
    // timeout, and the post-await guard discards any late output.
    for (const controller of [...extractionControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    // Abort and await the idle maintenance batch (topic.pending/topic.set/
    // maintain.associate plus its model call): no maintenance child or
    // gateway socket outlives shutdown. The batch settles through its own
    // abort handling, so this wait is bounded by the call deadlines.
    for (const controller of [...idleMaintenanceControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    const maintenance = idleMaintenanceInFlight;
    if (maintenance !== null) {
      await maintenance.catch(() => undefined);
    }
    // Abort EVERY active drain tick (recovery, foreground, and idle alike):
    // each tick owns a controller, so in-flight CLI children are hard-killed
    // here instead of running to their own timeout (up to 120s for distill).
    // Aborted jobs stay pending with bounded backoff (never acked, never
    // lost), and the in-flight tick is awaited below so no orphan survives.
    idleDrainActive = false;
    for (const controller of [...drainControllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    const active = drainInFlight;
    if (active !== null) {
      await active.catch(() => undefined);
    }
    // Abort and await EVERY in-flight graph projection read: the global
    // pager and local reads share the same tracking, so shutdown cancels
    // their CLI children and waits for them to settle before bootstrap
    // closes the kernel DB. The post-await fence keeps a late page from
    // minting handles/projection rows after `stopped`.
    for (const entry of [...graphReads]) {
      try {
        entry.controller.abort();
      } catch {
        // Best effort.
      }
    }
    await Promise.all([...graphReads].map((entry) => entry.settled));
    // Track pending explicit stagings: an in-flight stageMemoryMutation
    // observes `stopped` via throwIfStagingCancelled after its awaited read
    // and immediately before its atomic write, so no post-stop write lands.
    // Await their settlement here (bounded) — never fire-and-forget.
    const deadline = Date.now() + 5000;
    while (pendingStagings > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    recallHook,
    notifyForeground,
    onRunCompleted,
    start,
    stop,
    drainOnce: () => drainOnce(),
    searchMemories,
    getMemoryStats,
    getMemoryDetail,
    getMemoryGraphGlobal,
    getMemoryGraphLocal,
    stageMemoryMutation,
    getMemoryOperation,
    getMemoryRecallExposure,
    hashDrainingReplay,
  };
}
