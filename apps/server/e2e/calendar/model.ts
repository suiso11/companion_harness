// C15 dedicated Calendar fake E2E harness (2/3): scripted FAKE model.
//
// The REAL agent strategy (`createAgentStrategy`, "m0-default") drives this
// gateway exactly like a real local model: the agent projects prompt/history,
// calls `chat(request)`, executes returned native tool calls through the
// REAL ToolBroker (calendar.search / reference.open / reference.refresh),
// and feeds every result back. No HTTP ever leaves the process.
//
// The script keys the fixed plan on the ORIGINAL turn input text only (the
// TEXT_* constants in ports.ts) and derives its FINAL answer citations from
// the rN labels actually delivered in the last real tool feedback, so the
// answers always cite genuinely granted evidence for the current run.

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

const SEARCH_RANGE = {
  start: "2026-10-01T00:00:00Z",
  end: "2026-10-31T00:00:00Z",
} as const;

type PlanName = "search" | "refresh" | "delete";

interface GatewayState {
  plan: PlanName | null;
  /**
   * Identity of the turn currently being scripted: the number of user
   * messages in the request. A NEW turn (count change) always restarts the
   * fixed plan, even when consecutive turns share the same plan name — the
   * state is per-turn progress, never global across turns.
   */
  turn: number;
  /** Step index inside the fixed plan (chat call number within the turn). */
  step: number;
  /** Highest rN ordinal delivered in the last real tool feedback of the turn. */
  learnedOrdinal: number | null;
}

function lastToolFeedback(request: ChatRequest): string | null {
  const messages: ChatMessage[] = request.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ChatMessage | undefined;
    if (message === undefined) continue;
    if (message.role === "tool" && typeof message.content === "string") {
      return message.content;
    }
  }
  return null;
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

function userMessageCount(request: ChatRequest): number {
  let count = 0;
  for (const message of request.messages) {
    if (message.role === "user") count += 1;
  }
  return count;
}

function requestText(request: ChatRequest): string {
  let text = "";
  for (const message of request.messages) {
    if (message.role === "user" && typeof message.content === "string") {
      text += `\n${message.content}`;
    }
  }
  return text;
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

function citedAnswer(state: GatewayState, text: string): ChatResult {
  const ordinal = state.learnedOrdinal;
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
  const state: GatewayState = {
    plan: null,
    turn: -1,
    step: 0,
    learnedOrdinal: null,
  };
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/api/chat",
    async chat(request: ChatRequest): Promise<ChatResult> {
      const plan = selectPlan(requestText(request));
      if (plan === null) {
        // Defensive default: never invent tool calls for foreign prompts.
        return {
          text: "unscripted",
          toolCalls: [],
          stopReason: "stop",
        };
      }
      const turn = userMessageCount(request);
      if (plan !== state.plan || turn !== state.turn) {
        state.plan = plan;
        state.turn = turn;
        state.step = 0;
        state.learnedOrdinal = null;
      }
      const feedback = lastToolFeedback(request);
      if (feedback !== null) {
        const learned = learnDeliveredOrdinal(feedback);
        if (learned !== null) state.learnedOrdinal = learned;
      }
      const step = state.step;
      state.step += 1;
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
        return citedAnswer(state, ANSWER_SEARCH_TEXT);
      }
      if (plan === "refresh") {
        // Plan: refresh the delivered stored rN -> cite the newly
        // materialized rN (rewritten fake upstream revision).
        if (step === 0) {
          return answerResult(
            toolCall("reference.refresh", { referenceId: "r1" }),
          );
        }
        return citedAnswer(state, ANSWER_REFRESH_TEXT);
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
      return citedAnswer(state, ANSWER_TOMBSTONE_TEXT);
    },
  };
}
