// Spontaneous thought + speech service.
//
// Two bounded loops share one journal:
//   1. Thought pass: recent normal memories + recent conversation -> one
//      research topic -> Web search (local SearXNG) -> a private thought
//      note (observation + open question).
//   2. Speech pass (once/day by default): pick an open thought -> one
//      natural observation + deepening question -> post as a companion_text
//      Turn via the existing repository path.
//
// The service never writes user memory, never uses sensitive memories, and
// never stores prompts/raw conversation in the journal. Tools are not
// restricted here: the thought pass uses the same local model and the
// existing loopback search client.
//
// Dry-run mode logs the candidates without posting. Feedback (asked/replied/
// ignored) is durable on the journal row for later learning.

import { searchSearx, type WebSnippet } from "@companion/connector-web";
import type { WebSearchConfig } from "@companion/contracts";
import { type KernelRepository, NIHONGO_LITE } from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import {
  BACKGROUND_OWNER_SPONTANEOUS,
  type BackgroundResourceGate,
} from "./background_resource.js";
import type { SpeechConfig } from "./config.js";
import type { DayActivityStore } from "./day_activity.js";
import type { DiaryEntry, DiaryStore } from "./diary_store.js";
import type { ServerLogger } from "./logger.js";
import {
  callMemoryCli,
  type MemoryCliAddress,
  type MemoryCliEnvelope,
} from "./memory_cli.js";
import { stripOneJsonFence } from "./memory_service.js";
import {
  isThoughtKind,
  type ThoughtRow,
  type ThoughtSource,
  type ThoughtStore,
} from "./thought_store.js";
import { isRecord } from "./type_guards.js";

/**
 * Wall bound for one background gateway call. Same local-gateway bound as
 * memory extraction (`MEMORY_EXTRACT_TIMEOUT_MS`): without it a hung call
 * holds the shared background gate and stalls every other background unit.
 */
export const SPONTANEOUS_MODEL_TIMEOUT_MS = 120_000;
export const SPONTANEOUS_MAX_MEMORIES = 60;
export const SPONTANEOUS_MAX_QUERIES = 3;
export const SPONTANEOUS_MAX_SEARCH_RESULTS = 5;
export const SPONTANEOUS_MAX_CONTEXT_CP = 3000;
const SPEECH_FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Retry cadence while a pass is blocked BEFORE it spends its interval. */
const SPONTANEOUS_RETRY_MS = 10 * 60_000;
/** Boot catch-up: the day may have rolled over while the server was down. */
const DIARY_BOOT_DELAY_MS = 120_000;
/** The diary is written at 00:05 local, once per finished day. */
const DIARY_TARGET_MINUTE = 5;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SpontaneousServiceDeps {
  readonly repo: KernelRepository;
  readonly store: ThoughtStore;
  readonly diary: DiaryStore;
  /** Read-only per-day companion/task/action activity for the diary. */
  readonly activity: DayActivityStore;
  readonly config: SpeechConfig;
  readonly memory: MemoryCliAddress;
  readonly scope: string;
  readonly webSearch: WebSearchConfig;
  readonly gateway: ModelGateway | null;
  readonly model: string;
  readonly background: Pick<
    BackgroundResourceGate,
    "tryAcquire" | "release" | "closed"
  > | null;
  readonly timeZone: string;
  /** Main-conversation persona instructions (null when unset). */
  readonly personaInstructions?: () => string | null;
  readonly logger?: ServerLogger;
  /** Most recently viewed chat session (in-memory presence), when available. */
  readonly presence?: { active(at?: number): string | null };
  readonly now?: () => number;
  /** Test seam: local time-of-day minutes (defaults to Intl in timeZone). */
  readonly minutesOfDay?: (now: number) => number;
  /** Test seam: replace the loopback search call. */
  readonly search?: typeof searchSearx;
  /** Test seam: replace the bounded remind CLI call. */
  readonly memoryCall?: typeof callMemoryCli;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface SpontaneousService {
  start(): void;
  stop(): Promise<void>;
  /** One bounded thought pass (also used by tests). */
  runThoughtPass(): Promise<"created" | "skipped" | "error">;
  /** One bounded speech pass (also used by tests). */
  runSpeechPass(): Promise<"spoken" | "dry-run" | "skipped" | "error">;
  /** One bounded diary pass (also used by tests). */
  runDiaryPass(): Promise<"written" | "skipped" | "busy" | "error">;
}

interface MemoryItem {
  readonly id: string;
  readonly kind: "user_fact" | "summary";
  readonly snippet: string;
  readonly evidence: string | null;
  readonly createdAt: string;
}

interface SearchItem {
  readonly title: string | null;
  readonly snippet: string | null;
  readonly url: string;
}

function cpLength(value: string): number {
  return Array.from(value).length;
}

function boundedString(
  value: unknown,
  min: number,
  max: number,
): string | null {
  if (typeof value !== "string") return null;
  const size = cpLength(value);
  if (size < min || size > max || value.includes("\0")) return null;
  return value;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripOneJsonFence(text));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const RESEARCH_SYSTEM = `You are the companion's private curiosity planner.
Choose ONE topic worth learning more about from the supplied memories and recent conversation.
Return ONLY strict JSON:
{"action":"research"|"skip","topic":"...","queries":["..."],"memoryIndexes":[0]}
Rules:
- queries: 1-3 general web search queries (each 1-200 chars).
- Never include personal names, emails, phone numbers, addresses, health/financial specifics, or quoted private text in a query.
- memoryIndexes: the supplied mN indexes the topic is based on (0-3 entries).
- action=skip when nothing is genuinely worth researching.`;

const THOUGHT_SYSTEM = `You write one private note for a companion, in Japanese.
The note is an observation grounded in the supplied memories/search snippets plus ONE open question that deepens the user's own experience.
Rules:
- 1-3 sentences, at most 400 characters.
- Never write "ユーザーは", IDs, URLs, or analysis jargon.
- Do not invent facts not present in the memories or search snippets.
- Ask about the user's experience, meaning, or next step; no interrogation.
Return ONLY strict JSON:
{"kind":"survey"|"question"|"hypothesis"|"observation","body":"...","topics":["..."]}
topics: 0-3 short general-category nouns.`;

const DIARY_SYSTEM = `You write the companion's own private diary page for one day, in Japanese.
Write in first person, based ONLY on the supplied conversation, companion messages, tasks, actions, and memories of that day.
The entry is Markdown with exactly these three H3 sections, in this order:
### やったこと
What the user did that day, 1-3 short lines.
### コンパニオンの動き
What the companion itself did that day: messages it sent, actions it ran, task changes.
### タスク
The day's tasks organized as done / in progress / next, from the supplied task list and conversation. Write 特になし when there are none.
Rules:
- 40-1600 characters in total.
- Never write IDs, URLs, or analysis jargon.
- Do not address the user: this is a diary, not a message.
- Invent nothing that is not present in the supplied material.
Return ONLY strict JSON:
{"entry":"### やったこと\\n...\\n### コンパニオンの動き\\n...\\n### タスク\\n..."}`;

const SPEECH_SYSTEM = `You are the companion speaking first, in Japanese.
Using the supplied private note, sources, and recent conversation, either stay silent or write ONE natural message.
The message must contain a concrete observation and exactly ONE open question that deepens the user's own experience.
Rules:
- Exactly one question mark in the whole message; never ask a second question.
- Do not mention the private note, sources, analysis, or that you were thinking/connecting memories. Just speak the observation naturally.
- No memory recitation, no "ユーザーは", no IDs/URLs, no analysis jargon, no pressure to answer.
- At most the requested character count; 1-3 sentences.
- If the note is not worth sharing right now, return silent.
Return ONLY strict JSON:
{"action":"speak"|"silent","message":"..."}`;

export function createSpontaneousService(
  deps: SpontaneousServiceDeps,
): SpontaneousService {
  const {
    repo,
    store,
    diary,
    config,
    memory,
    scope,
    webSearch,
    gateway,
    model,
    background,
    timeZone,
  } = deps;
  const now = deps.now ?? (() => Date.now());
  const search = deps.search ?? searchSearx;
  const readMemory = deps.memoryCall ?? callMemoryCli;
  const setTimeoutFn = deps.setTimeout ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
  const memoryLimit = Math.max(
    5,
    Math.min(SPONTANEOUS_MAX_MEMORIES, config.memoryLimit),
  );

  let started = false;
  let stopped = false;
  let thoughtTimer: ReturnType<typeof setTimeout> | undefined;
  let speechTimer: ReturnType<typeof setTimeout> | undefined;
  let diaryTimer: ReturnType<typeof setTimeout> | undefined;
  // Last wall time of a pass that actually acquired the shared gate. A pass
  // blocked before admission must not spend the whole interval: the loops
  // retry it on the short tick instead of losing a day.
  let thoughtAdmittedAt: number | null = null;
  let speechAdmittedAt: number | null = null;
  const controllers = new Set<AbortController>();

  function log(
    level: "info" | "warn",
    code: string,
    fields?: Record<string, string | number | boolean | null>,
  ): void {
    try {
      deps.logger?.[level](code, fields);
    } catch {
      // Logging never fails this background work.
    }
  }

  function abortAll(): void {
    for (const controller of [...controllers]) {
      try {
        controller.abort();
      } catch {
        // Best effort.
      }
    }
    controllers.clear();
  }

  function newController(): AbortController {
    const controller = new AbortController();
    controllers.add(controller);
    return controller;
  }

  function releaseController(controller: AbortController): void {
    controllers.delete(controller);
  }

  function minutesOfDayAt(at: number): number {
    if (deps.minutesOfDay) return deps.minutesOfDay(at);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  }

  /** Local calendar day (YYYY-MM-DD) in the configured time zone. */
  function localDay(at: number): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(at));
    const part = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  /** Previous calendar day via UTC date arithmetic (not now - 24h). */
  function previousDay(day: string): string {
    const [year, month, date] = day.split("-").map(Number);
    const utc = Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1);
    return new Date(utc - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function inQuietHours(at: number): boolean {
    const hours = config.quietHours;
    if (hours === null) return false;
    const minute = minutesOfDayAt(at);
    const [sh, sm] = hours.start.split(":").map(Number);
    const [eh, em] = hours.end.split(":").map(Number);
    const start = (sh ?? 0) * 60 + (sm ?? 0);
    const end = (eh ?? 0) * 60 + (em ?? 0);
    return start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end;
  }

  /**
   * Where a companion message can land: preference for the session the user
   * is viewing, but only one that has a user turn. A freshly created (empty)
   * session is the newest row and used to win here, which made the speech
   * pass skip every attempt until a newer session appeared.
   */
  function targetSession(at: number): string | null {
    const active = deps.presence?.active(at) ?? null;
    if (active !== null) {
      try {
        repo.getSession(active);
        if (store.lastUserTurnAt(active) !== null) return active;
      } catch {
        // Stale/foreign presence: fall through to the latest conversation.
      }
    }
    try {
      const latest = repo.latestSessionId();
      if (latest !== null && store.lastUserTurnAt(latest) !== null) {
        return latest;
      }
      // Only the (uncommon) empty-newest-session case pays the wider scan.
      return (
        repo
          .listSessions({ limit: 50 })
          .sessions.find((session) => session.lastUserAt !== null)?.id ?? null
      );
    } catch {
      return null;
    }
  }

  async function memoryItems(): Promise<MemoryItem[]> {
    // record.list is byte-budgeted (8 KiB by default): requesting the whole
    // memoryLimit at once can answer LIMIT_EXCEEDED and yield nothing. Page
    // backwards with `until` (10 rows/page) until enough normal candidates.
    const PAGE = 10;
    const out: MemoryItem[] = [];
    const seen = new Set<string>();
    let until: string | undefined;
    for (let page = 0; page < 6 && out.length < memoryLimit; page += 1) {
      let envelope: MemoryCliEnvelope;
      try {
        envelope = await readMemory(
          memory,
          "record.list",
          until === undefined
            ? { scope, limit: PAGE }
            : { scope, limit: PAGE, until },
          undefined,
        );
      } catch {
        break;
      }
      if (!envelope.ok || !isRecord(envelope.data)) break;
      const items = envelope.data.items;
      if (!Array.isArray(items) || items.length === 0) break;
      let lastCreatedAt: string | undefined;
      for (const item of items) {
        if (!isRecord(item)) continue;
        const id = boundedString(item.id, 1, 256);
        const kind = item.kind;
        const snippet = boundedString(item.snippet, 1, 2000);
        const status = item.status;
        const privacy = item.privacy;
        const sensitivity = isRecord(privacy) ? privacy.sensitivity : null;
        const createdAt = boundedString(item.createdAt, 1, 64);
        if (typeof item.createdAt === "string") lastCreatedAt = item.createdAt;
        if (
          id === null ||
          snippet === null ||
          createdAt === null ||
          seen.has(id) ||
          status !== "active" ||
          (kind !== "user_fact" && kind !== "summary") ||
          // Older remind builds do not expose privacy: fail closed.
          sensitivity !== "normal"
        ) {
          continue;
        }
        seen.add(id);
        out.push({
          id,
          kind,
          snippet,
          evidence: boundedString(item.evidence, 1, 500),
          createdAt,
        });
      }
      if (items.length < PAGE || lastCreatedAt === undefined) break;
      until = lastCreatedAt;
    }
    return out;
  }

  /**
   * One day's conversation across up to three recent sessions ("" when the
   * day has no user turn; other activity may still make the day eligible).
   */
  function dayConversation(day: string): string {
    const lines: string[] = [];
    try {
      for (const session of repo
        .listSessions({ limit: 50 })
        .sessions.slice(0, 3)) {
        const history = repo.getHistory(session.id, { limit: 50 });
        for (const item of history.items) {
          if (item.kind !== "user_text") continue;
          if (localDay(item.createdAt) !== day) continue;
          const user = boundedString(item.text, 1, 800);
          if (user === null) continue;
          lines.push(`User: ${user}`);
          const result = item.selectedRun?.result;
          if (isRecord(result)) {
            const answer = boundedString(result.text, 1, 800);
            if (answer !== null) lines.push(`Assistant: ${answer}`);
          }
        }
      }
    } catch {
      return "";
    }
    const context = lines.join("\n");
    return cpLength(context) > SPONTANEOUS_MAX_CONTEXT_CP
      ? Array.from(context).slice(0, SPONTANEOUS_MAX_CONTEXT_CP).join("")
      : context;
  }

  function recentContext(sessionId: string): string {
    let history: ReturnType<KernelRepository["getHistory"]>;
    try {
      history = repo.getHistory(sessionId, { limit: 8 });
    } catch {
      return "";
    }
    const lines: string[] = [];
    for (const item of history.items) {
      if (item.kind !== "user_text") continue;
      const user = boundedString(item.text, 1, 800);
      if (user !== null) lines.push(`User: ${user}`);
      const result = item.selectedRun?.result;
      if (isRecord(result)) {
        const answer = boundedString(result.text, 1, 800);
        if (answer !== null) lines.push(`Assistant: ${answer}`);
      }
    }
    return cpLength(lines.join("\n")) > SPONTANEOUS_MAX_CONTEXT_CP
      ? Array.from(lines.join("\n"))
          .slice(0, SPONTANEOUS_MAX_CONTEXT_CP)
          .join("")
      : lines.join("\n");
  }

  async function chatJson(
    system: string,
    user: string,
    maxOutputTokens: number,
    controller: AbortController,
  ): Promise<Record<string, unknown> | null> {
    if (gateway === null) return null;
    let result: ChatResult;
    try {
      result = await gateway.chat(
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          maxOutputTokens,
          tools: [],
          reasoning: "off",
        },
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(SPONTANEOUS_MODEL_TIMEOUT_MS),
          ]),
          maxResponseBytes: 256 * 1024,
        },
      );
    } catch {
      return null;
    }
    return parseJsonObject(result.text);
  }

  async function research(
    memories: readonly MemoryItem[],
    context: string,
    controller: AbortController,
  ): Promise<{
    topic: string;
    queries: string[];
    memoryIndexes: number[];
  } | null> {
    const memoryLines = memories
      .map((m, index) => {
        const evidence = m.evidence === null ? "" : ` evidence="${m.evidence}"`;
        return `m${index} [${m.kind}] ${m.snippet}${evidence}`;
      })
      .join("\n");
    const parsed = await chatJson(
      RESEARCH_SYSTEM,
      `Memories:\n${memoryLines}\n\nRecent conversation:\n${context || "(none)"}`,
      400,
      controller,
    );
    if (parsed === null || parsed.action !== "research") return null;
    const topic = boundedString(parsed.topic, 1, 200);
    if (topic === null) return null;
    if (!Array.isArray(parsed.queries)) return null;
    const queries: string[] = [];
    for (const value of parsed.queries.slice(0, SPONTANEOUS_MAX_QUERIES)) {
      const query = boundedString(value, 1, 200);
      if (query === null) continue;
      if (/[\r\n]/.test(query)) continue;
      queries.push(query);
    }
    if (queries.length === 0) return null;
    const indexes: number[] = [];
    if (Array.isArray(parsed.memoryIndexes)) {
      for (const value of parsed.memoryIndexes.slice(0, 3)) {
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value < memories.length &&
          !indexes.includes(value)
        ) {
          indexes.push(value);
        }
      }
    }
    return { topic, queries, memoryIndexes: indexes };
  }

  async function searchWeb(
    queries: readonly string[],
    controller: AbortController,
  ): Promise<SearchItem[]> {
    const baseUrl = webSearch.searxng_base_url;
    if (webSearch.enabled !== true || baseUrl === undefined) return [];
    const out: SearchItem[] = [];
    const seen = new Set<string>();
    for (const query of queries.slice(0, SPONTANEOUS_MAX_QUERIES)) {
      if (controller.signal.aborted) break;
      let results: WebSnippet[];
      try {
        results = await search({
          baseUrl,
          query,
          maxResults: 3,
          timeoutMs: Math.min(webSearch.timeout_ms, 8000),
          maxResponseBytes: Math.min(webSearch.max_response_bytes, 512 * 1024),
          signal: controller.signal,
        });
      } catch (error) {
        log("warn", "speech.web_search_failed");
        continue;
      }
      for (const result of results) {
        if (out.length >= SPONTANEOUS_MAX_SEARCH_RESULTS) break;
        if (seen.has(result.url)) continue;
        seen.add(result.url);
        out.push({
          title: result.title,
          snippet: result.snippet,
          url: result.url,
        });
      }
      if (out.length >= SPONTANEOUS_MAX_SEARCH_RESULTS) break;
    }
    return out;
  }

  async function writeThought(
    sessionId: string,
    memories: readonly MemoryItem[],
    topic: string,
    researchIndexes: readonly number[],
    results: readonly SearchItem[],
    controller: AbortController,
  ): Promise<ThoughtRow | null> {
    const sourceLines = results
      .map(
        (r, index) =>
          `s${index} ${r.title ?? "(no title)"}: ${r.snippet ?? ""}`,
      )
      .join("\n");
    const parsed = await chatJson(
      THOUGHT_SYSTEM,
      `Topic: ${topic}\nMemories:\n${memories
        .map((m, index) => `m${index} [${m.kind}] ${m.snippet}`)
        .join("\n")}\nSearch results:\n${sourceLines || "(none)"}`,
      500,
      controller,
    );
    if (parsed === null) {
      log("warn", "speech.thought_invalid_json");
      return null;
    }
    if (!isThoughtKind(parsed.kind)) {
      log("warn", "speech.thought_invalid_kind");
      return null;
    }
    // The thought is private: only bound the size here. Style/URL/pronoun
    // constraints belong to the public speech message, not the journal.
    const body = boundedString(parsed.body, 1, 600);
    if (body === null) {
      log("warn", "speech.thought_invalid_body");
      return null;
    }
    const topics: string[] = [];
    if (Array.isArray(parsed.topics)) {
      for (const value of parsed.topics.slice(0, 3)) {
        const topicValue = boundedString(value, 1, 32);
        if (topicValue !== null) topics.push(topicValue);
      }
    }
    const memoryIds = researchIndexes
      .map((index) => memories[index]?.id)
      .filter((id): id is string => id !== undefined);
    const sources: ThoughtSource[] = results.map((result) => ({
      title: result.title,
      url: result.url,
    }));
    try {
      return store.insert({
        sessionId,
        kind: parsed.kind,
        body,
        topics,
        memoryIds,
        sources,
        now: now(),
      });
    } catch {
      log("warn", "speech.thought_store_failed");
      return null;
    }
  }

  async function runThoughtPass(): Promise<"created" | "skipped" | "error"> {
    if (!started || stopped || !config.enabled) return "skipped";
    const at = now();
    const last = store.lastThoughtAt();
    if (last !== null && at - last < config.thoughtIntervalMs) {
      return "skipped";
    }
    const sessionId = targetSession(at);
    if (sessionId === null) return "skipped";
    if (background?.closed) return "skipped";
    const lease = background?.tryAcquire(BACKGROUND_OWNER_SPONTANEOUS) ?? null;
    if (background !== null && lease === null) return "skipped";
    thoughtAdmittedAt = at;
    const controller = newController();
    try {
      const memories = await memoryItems();
      if (memories.length === 0) {
        log("info", "speech.thought_skipped_no_memories");
        return "skipped";
      }
      const context = recentContext(sessionId);
      const plan = await research(memories, context, controller);
      if (plan === null) {
        log("info", "speech.thought_skipped_no_topic");
        return "skipped";
      }
      const results = await searchWeb(plan.queries, controller);
      const thought = await writeThought(
        sessionId,
        memories,
        plan.topic,
        plan.memoryIndexes,
        results,
        controller,
      );
      if (thought === null) {
        log("info", "speech.thought_skipped_invalid");
        return "skipped";
      }
      log("info", "speech.thought_created", {
        kind: thought.kind,
        sources: thought.sources.length,
        memories: thought.memoryIds.length,
      });
      return "created";
    } catch {
      log("warn", "speech.thought_failed");
      return "error";
    } finally {
      releaseController(controller);
      if (lease !== null) background?.release(lease);
    }
  }

  function reconcileFeedback(at: number): void {
    for (const thought of store.listAskedWithoutReply(10)) {
      const session = thought.speechSessionId ?? thought.sessionId;
      const askedAt = thought.askedAt;
      if (askedAt === null) continue;
      const reply = store.findUserTurnAfter(session, askedAt);
      if (reply !== null) {
        store.markReplied(thought.id, reply.createdAt, reply.turnId);
      } else if (at - askedAt >= SPEECH_FEEDBACK_WINDOW_MS) {
        store.markIgnored(thought.id);
      }
    }
  }

  async function speakFromThought(
    thought: ThoughtRow,
    context: string,
    controller: AbortController,
  ): Promise<string | null> {
    const sources = thought.sources
      .map((source) => `${source.title ?? "(no title)"}: ${source.url}`)
      .join("\n");
    const parsed = await chatJson(
      `${SPEECH_SYSTEM}\n\n${NIHONGO_LITE}\n\nこの発話は相手への返事ではない。nihongo の規則4（返事の長さ・質問を足さない）は当てず、上の英語の指示（発話に質問をちょうど1つ含める、文字数、JSON形式）を優先する。`,
      `Private note: ${thought.body}\nTopics: ${thought.topics.join(", ") || "(none)"}\nSources:\n${
        sources || "(none)"
      }\nRecent conversation:\n${context || "(none)"}\nMax characters: ${config.maxChars}`,
      400,
      controller,
    );
    if (parsed === null || parsed.action !== "speak") return null;
    const message = boundedString(parsed.message, 1, config.maxChars);
    if (message === null) return null;
    if (/ユーザーは/.test(message)) return null;
    if (/https?:\/\//i.test(message)) return null;
    if (UUID_RE.test(message)) return null;
    const questions = message.match(/[?？]/g)?.length ?? 0;
    if (questions !== 1) return null;
    return message;
  }

  const joinOrNone = (items: readonly string[]): string =>
    items.length === 0 ? "(none)" : items.join("\n");

  async function runDiaryPass(): Promise<
    "written" | "skipped" | "busy" | "error"
  > {
    if (!started || stopped || !config.enabled) return "skipped";
    const at = now();
    const day = previousDay(localDay(at));
    let existing: DiaryEntry | null;
    try {
      existing = diary.get(day);
    } catch {
      log("warn", "diary.failed");
      return "error";
    }
    if (existing !== null) return "skipped";
    if (background?.closed) return "skipped";
    const lease = background?.tryAcquire(BACKGROUND_OWNER_SPONTANEOUS) ?? null;
    if (background !== null && lease === null) return "busy";
    const controller = newController();
    try {
      const conversation = dayConversation(day);
      const activity = deps.activity.read(day, localDay);
      if (
        conversation.length === 0 &&
        activity.companionMessages.length === 0 &&
        activity.tasks.length === 0 &&
        activity.actions.length === 0
      ) {
        log("info", "diary.skipped_no_activity");
        return "skipped";
      }
      let memories: MemoryItem[] = [];
      try {
        memories = (await memoryItems()).slice(0, 10);
      } catch {
        // Memories are optional context; the day's conversation is enough.
      }
      const personaRaw = deps.personaInstructions?.() ?? null;
      const persona =
        personaRaw === null
          ? ""
          : Array.from(personaRaw).slice(0, 2000).join("").trim();
      const diarySystem = `${DIARY_SYSTEM}\n\n${NIHONGO_LITE}\n\n上の英語の指示（一人称で書く、20〜800字、宛先を書かない、JSON形式で返す）を nihongo の規則より優先する。`;
      const system =
        persona.length === 0
          ? diarySystem
          : `${diarySystem}\n\nあなたの人物設定:\n${persona}`;
      const memoryLines = memories
        .map((memory, index) => `m${index} [${memory.kind}] ${memory.snippet}`)
        .join("\n");
      const parsed = await chatJson(
        system,
        `Day: ${day}\nMemories:\n${memoryLines || "(none)"}\nUser conversation:\n${conversation || "(none)"}\nCompanion messages:\n${joinOrNone(activity.companionMessages)}\nTasks:\n${joinOrNone(activity.tasks)}\nActions:\n${joinOrNone(activity.actions)}`,
        2600,
        controller,
      );
      if (parsed === null) {
        // Transport failure and unparseable model output cannot produce an
        // entry; retry on the short tick like any other failed pass.
        log("warn", "diary.failed");
        return "error";
      }
      const entry = boundedString(parsed.entry, 40, 1800);
      if (
        entry === null ||
        /https?:\/\//i.test(entry) ||
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
          entry,
        )
      ) {
        log("info", "diary.skipped_invalid");
        return "skipped";
      }
      if (config.mode === "dry-run") {
        log("info", "diary.dry_run", { chars: cpLength(entry) });
        return "written";
      }
      if (diary.insert(day, entry, now()) === null) return "skipped";
      log("info", "diary.written", { chars: cpLength(entry) });
      return "written";
    } catch {
      log("warn", "diary.failed");
      return "error";
    } finally {
      releaseController(controller);
      if (lease !== null) background?.release(lease);
    }
  }

  async function runSpeechPass(): Promise<
    "spoken" | "dry-run" | "skipped" | "error"
  > {
    if (!started || stopped || !config.enabled) return "skipped";
    const at = now();
    reconcileFeedback(at);
    if (inQuietHours(at)) return "skipped";
    if (
      store.countAskedSince(at - 24 * 60 * 60 * 1000) >= config.maxSpeechPerDay
    ) {
      return "skipped";
    }
    const sessionId = targetSession(at);
    if (sessionId === null) return "skipped";
    const lastUser = store.lastUserTurnAt(sessionId);
    if (lastUser === null || at - lastUser < config.minQuietMs) {
      return "skipped";
    }
    if (store.lastTurnKind(sessionId) === "companion_text") return "skipped";
    const lastSpeech = store.lastSpeechAt();
    if (lastSpeech !== null && at - lastSpeech < config.minGapMs) {
      return "skipped";
    }
    try {
      if (repo.getActiveRun(sessionId) !== null) return "skipped";
    } catch {
      return "skipped";
    }
    const thought = store.listOpen(1)[0];
    if (thought === undefined) return "skipped";
    if (background?.closed) return "skipped";
    const lease = background?.tryAcquire(BACKGROUND_OWNER_SPONTANEOUS) ?? null;
    if (background !== null && lease === null) return "skipped";
    speechAdmittedAt = at;
    const controller = newController();
    try {
      const message = await speakFromThought(
        thought,
        recentContext(sessionId),
        controller,
      );
      if (message === null) {
        log("info", "speech.skipped_model_silent");
        return "skipped";
      }
      if (config.mode === "dry-run") {
        log("info", "speech.dry_run", { chars: cpLength(message) });
        return "dry-run";
      }
      const posted = repo.postCompanionMessage(sessionId, message, {
        now: at,
        timeZone,
      });
      store.markAsked(thought.id, at, posted.turnId, sessionId);
      log("info", "speech.spoken", { chars: cpLength(message) });
      return "spoken";
    } catch {
      log("warn", "speech.failed");
      return "error";
    } finally {
      releaseController(controller);
      if (lease !== null) background?.release(lease);
    }
  }

  /**
   * Delay until the next attempt. `last` is the last attempt the loop already
   * paid for (an admitted pass, or for the thought loop the last created
   * thought): the interval runs from there, plus 1ms so a due fire can never
   * be skipped as a strict-boundary no-op. A pass blocked before admission
   * leaves `last` stale, so the loop retries on the short tick instead of
   * losing a day.
   */
  function nextDelay(last: number | null, intervalMs: number): number {
    const nowMs = now();
    const due = last === null ? nowMs + 1 : last + intervalMs + 1;
    return Math.max(SPONTANEOUS_RETRY_MS, due - nowMs);
  }

  function lastThoughtAt(): number | null {
    let last = thoughtAdmittedAt;
    try {
      const created = store.lastThoughtAt();
      if (created !== null && (last === null || created > last)) last = created;
    } catch {
      // Best effort: the admitted attempt still paces the loop.
    }
    return last;
  }

  function scheduleThought(delay: number): void {
    thoughtTimer = setTimeoutFn(() => {
      thoughtTimer = undefined;
      void runThoughtPass()
        .catch(() => undefined)
        .finally(() => {
          if (!started || stopped) return;
          scheduleThought(nextDelay(lastThoughtAt(), config.thoughtIntervalMs));
        });
    }, delay);
    thoughtTimer.unref?.();
  }

  /** Delay to the next 00:05 local; an exact 00:05 hit waits a full day. */
  function nextDiaryDelay(at: number): number {
    const until =
      (DIARY_TARGET_MINUTE - (minutesOfDayAt(at) % 1440) + 1440) % 1440;
    return (until === 0 ? 1440 : until) * 60_000;
  }

  function scheduleDiary(delay: number): void {
    diaryTimer = setTimeoutFn(() => {
      diaryTimer = undefined;
      void (async () => {
        let next = SPONTANEOUS_RETRY_MS;
        try {
          const result = await runDiaryPass();
          if (result !== "busy" && result !== "error") {
            next = nextDiaryDelay(now());
          }
        } catch {
          // Retry on the short tick: the pass never rejects on its own.
        }
        if (started && !stopped) scheduleDiary(next);
      })();
    }, delay);
    diaryTimer.unref?.();
  }

  function scheduleSpeech(delay: number): void {
    speechTimer = setTimeoutFn(() => {
      speechTimer = undefined;
      void runSpeechPass()
        .catch(() => undefined)
        .finally(() => {
          if (!started || stopped) return;
          scheduleSpeech(nextDelay(speechAdmittedAt, config.speechIntervalMs));
        });
    }, delay);
    speechTimer.unref?.();
  }

  return {
    start() {
      if (started || stopped || !config.enabled) return;
      started = true;
      // Do not fire immediately at boot; give foreground work a head start.
      const lead = Math.min(300_000, config.thoughtIntervalMs);
      scheduleThought(lead);
      scheduleSpeech(lead + 60_000);
      // Boot catch-up: a rollover during downtime must not lose the entry.
      scheduleDiary(DIARY_BOOT_DELAY_MS);
    },
    async stop() {
      stopped = true;
      started = false;
      if (thoughtTimer !== undefined) {
        clearTimeoutFn(thoughtTimer);
        thoughtTimer = undefined;
      }
      if (speechTimer !== undefined) {
        clearTimeoutFn(speechTimer);
        speechTimer = undefined;
      }
      if (diaryTimer !== undefined) {
        clearTimeoutFn(diaryTimer);
        diaryTimer = undefined;
      }
      abortAll();
    },
    runThoughtPass,
    runSpeechPass,
    runDiaryPass,
  };
}
