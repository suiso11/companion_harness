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
import type { KernelRepository } from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import {
  BACKGROUND_OWNER_SPONTANEOUS,
  type BackgroundResourceGate,
} from "./background_resource.js";
import type { SpeechConfig } from "./config.js";
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

export const SPONTANEOUS_MODEL_TIMEOUT_MS = 30_000;
export const SPONTANEOUS_MAX_MEMORIES = 60;
export const SPONTANEOUS_MAX_QUERIES = 3;
export const SPONTANEOUS_MAX_SEARCH_RESULTS = 5;
export const SPONTANEOUS_MAX_CONTEXT_CP = 3000;
const SPEECH_FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SpontaneousServiceDeps {
  readonly repo: KernelRepository;
  readonly store: ThoughtStore;
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
  readonly logger?: ServerLogger;
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

const SPEECH_SYSTEM = `You are the companion speaking first, in Japanese.
Using the supplied private note, sources, and recent conversation, either stay silent or write ONE natural message.
The message must contain a concrete observation and exactly ONE open question that deepens the user's own experience.
Rules:
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

  function inQuietHours(at: number): boolean {
    const hours = config.quietHours;
    if (hours === null) return false;
    const minute = deps.minutesOfDay
      ? deps.minutesOfDay(at)
      : (() => {
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(at));
          const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
          const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
          return h * 60 + m;
        })();
    const [sh, sm] = hours.start.split(":").map(Number);
    const [eh, em] = hours.end.split(":").map(Number);
    const start = (sh ?? 0) * 60 + (sm ?? 0);
    const end = (eh ?? 0) * 60 + (em ?? 0);
    return start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end;
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
          signal: controller.signal,
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
    if (background?.closed) return "skipped";
    const lease = background?.tryAcquire(BACKGROUND_OWNER_SPONTANEOUS) ?? null;
    if (background !== null && lease === null) return "skipped";
    const controller = newController();
    try {
      const sessionId = repo.latestSessionId();
      if (sessionId === null) return "skipped";
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
      SPEECH_SYSTEM,
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
    if (!/[?？]/.test(message)) return null;
    return message;
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
    const sessionId = repo.latestSessionId();
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

  function scheduleThought(delay: number): void {
    thoughtTimer = setTimeoutFn(() => {
      thoughtTimer = undefined;
      void runThoughtPass().catch(() => undefined);
      if (started && !stopped) {
        scheduleThought(config.thoughtIntervalMs);
      }
    }, delay);
    thoughtTimer.unref?.();
  }

  function scheduleSpeech(delay: number): void {
    speechTimer = setTimeoutFn(() => {
      speechTimer = undefined;
      void runSpeechPass().catch(() => undefined);
      if (started && !stopped) {
        scheduleSpeech(config.speechIntervalMs);
      }
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
      abortAll();
    },
    runThoughtPass,
    runSpeechPass,
  };
}
