// C15 dedicated Calendar fake E2E harness (2/3): scripted FAKE model.
//
// The REAL agent strategy (`createAgentStrategy`, "m0-default") drives this
// gateway exactly like a real local model: the agent projects prompt/history,
// calls `chat(request)`, executes returned native tool calls through the
// REAL ToolBroker (calendar.search / reference.open / reference.refresh),
// and feeds every result back. No HTTP ever leaves the process.
//
// The script is STATELESS: plan, step and final citations are derived from the
// request the agent actually sends (current request text + that turn's real
// tool feedback), so no shared/global turn state can reset a plan or lose an
// already delivered evidence grant across turns or sessions. The plan keys on
// the CURRENT turn input text only (the TEXT_* constants in ports.ts) and the
// final answer citations come from the rN labels really delivered in this
// turn's tool feedback, so answers only cite genuinely granted evidence.

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import {
  ANSWER_REFRESH_TEXT,
  ANSWER_SEARCH_TEXT,
  ANSWER_TOMBSTONE_TEXT,
  TEXT_DELETE,
  TEXT_REFRESH,
  TEXT_SEARCH,
} from "./ports.js";

/**
 * Framing the REAL agent strategy puts on the CURRENT turn request
 * (`projectPrompt`); distinguishes it from projected history user messages.
 */
const CURRENT_REQUEST_MARKER = "User request:";

const SEARCH_RANGE = {
  start: "2026-10-01T00:00:00Z",
  end: "2026-10-31T00:00:00Z",
} as const;

type PlanName = "search" | "refresh" | "delete";

/**
 * Index of the user message that carries the CURRENT turn request: the last
 * projected user message framed as `User request:\n`. Everything after it
 * is the current turn's own transcript (assistant tool calls + real tool
 * feedback), so the plan, the step index and the delivered evidence are
 * derived from the REQUEST ALONE — never from gateway-global mutable state.
 * A repair-hint user message (also projected as a user message) can never
 * displace the boundary.
 */
function currentRequestIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ChatMessage | undefined;
    if (
      message !== undefined &&
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes(CURRENT_REQUEST_MARKER)
    ) {
      return index;
    }
  }
  return -1;
}

/** Current-turn transcript: every message after the current request. */
function currentTranscript(
  request: ChatRequest,
  from: number,
): readonly ChatMessage[] {
  return from < 0 ? [] : request.messages.slice(from + 1);
}

/** Real tool feedback delivered in THIS turn, oldest first. */
function currentToolFeedback(
  request: ChatRequest,
  from: number,
): readonly string[] {
  const out: string[] = [];
  for (const message of currentTranscript(request, from)) {
    if (message.role === "tool" && typeof message.content === "string") {
      out.push(message.content);
    }
  }
  return out;
}

/** Highest `\"ordinal\":N` / `rN` label actually delivered (granted evidence). */
function learnDeliveredOrdinal(content: string): number | null {
  let best: number | null = null;
  const ordinals = content.matchAll(/"ordinal"\s*:\s*(\d+)/g);
  for (const match of ordinals) {
    const value = Number(match[1]);
    if (value >= 1 && value <= 100000 && (best === null || value > best)) {
      best = value;
    }
  }
  if (best !== null) return best;
  const labels = content.matchAll(/\br(\d+)\b/g);
  for (const match of labels) {
    const value = Number(match[1]);
    if (value >= 1 && value <= 100000 && (best === null || value > best)) {
      best = value;
    }
  }
  return best;
}

function selectPlan(requestTextValue: string): PlanName | null {
  if (requestTextValue.includes(TEXT_DELETE)) return "delete";
  if (requestTextValue.includes(TEXT_REFRESH)) return "refresh";
  if (requestTextValue.includes(TEXT_SEARCH)) return "search";
  return null;
}

function toolCall(name: string, args: unknown): NormalizedToolCall {
  return {
    id: `fake-${name}-${Math.random().toString(36).slice(2, 10)}`,
    name,
    arguments: args,
  };
}

function answerSubmit(
  text: string,
  citations: readonly string[],
): NormalizedToolCall {
  return toolCall("answer.submit", {
    version: 1,
    parts: [{ text, citations: [...citations] }],
  });
}

/** Cite the highest rN actually delivered in THIS turn's real feedback. */
function citedAnswer(ordinal: number | null, text: string): ChatResult {
  const citations = ordinal !== null ? [`r${ordinal}`] : [];
  return answerResult([answerSubmit(text, citations)]);
}

function answerResult(
  calls: NormalizedToolCall | readonly NormalizedToolCall[],
): ChatResult {
  const list = Array.isArray(calls) ? [...calls] : [calls];
  return { text: "", toolCalls: list, stopReason: "tool_calls" };
}

/**
 * Build the deterministic scripted gateway (ModelGateway contract). The
 * strategy only requires `capabilities.toolCalling`; no HTTP endpoint is
 * reachable (the baseUrl is loopback-empty and never fetched).
 */
export function createScriptedCalendarModelGateway(): ModelGateway {
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/api/chat",
    async chat(request: ChatRequest): Promise<ChatResult> {
      // Everything below is DERIVED FROM THIS REQUEST ONLY: the plan from the
      // current request text, the step from the current turn's real tool
      // feedback count, the citation from the ordinals those very feedbacks
      // delivered. No gateway-global mutable state exists, so neither a new
      // turn, a cross-session interleaving, nor a history/tool-feedback
      // combination can reset the plan or lose an already delivered grant.
      const requestIndex = currentRequestIndex(request.messages);
      const requestMessage =
        requestIndex < 0
          ? undefined
          : (request.messages[requestIndex] as ChatMessage | undefined);
      const plan =
        requestMessage === undefined ||
        typeof requestMessage.content !== "string"
          ? null
          : selectPlan(requestMessage.content);
      if (plan === null) {
        // Defensive default: never invent tool calls for foreign prompts.
        return {
          text: "unscripted",
          toolCalls: [],
          stopReason: "stop",
        };
      }
      // Safe current-transcript tool count: one step per real tool feedback
      // delivered in this turn, in request order.
      const feedback = currentToolFeedback(request, requestIndex);
      let learnedOrdinal: number | null = null;
      for (const content of feedback) {
        const learned = learnDeliveredOrdinal(content);
        if (learned !== null) {
          learnedOrdinal =
            learnedOrdinal === null || learned > learnedOrdinal
              ? learned
              : learnedOrdinal;
        }
      }
      const step = feedback.length;
      if (plan === "search") {
        // Plan: real calendar.search -> cite the delivered rN.
        if (step === 0) {
          return answerResult(
            toolCall("calendar.search", {
              query: "standup",
              start: SEARCH_RANGE.start,
              end: SEARCH_RANGE.end,
            }),
          );
        }
        return citedAnswer(learnedOrdinal, ANSWER_SEARCH_TEXT);
      }
      if (plan === "refresh") {
        // Plan: refresh the delivered stored rN -> cite the newly
        // materialized rN (rewritten fake upstream revision).
        if (step === 0) {
          return answerResult(
            toolCall("reference.refresh", { referenceId: "r1" }),
          );
        }
        return citedAnswer(learnedOrdinal, ANSWER_REFRESH_TEXT);
      }
      // Delete plan: stored OPEN first (the model addresses the retained
      // stored reference), then refresh (fails via the fake deleted
      // upstream; no new reference is materialized), then answer citing
      // the stored rN (never a new fabricated one).
      if (step === 0) {
        return answerResult(toolCall("reference.open", { referenceId: "r1" }));
      }
      if (step === 1) {
        return answerResult(
          toolCall("reference.refresh", { referenceId: "r1" }),
        );
      }
      return citedAnswer(learnedOrdinal, ANSWER_TOMBSTONE_TEXT);
    },
  };
}
