// Real main-agent turn for persona-chat autotalk (partner_main = 1).
//
// The main conversation is a RunEngine strategy: create/reuse one session per
// persona chat (deterministic idempotency key), post the persona's message as
// a user turn, let the engine run it with the full agent (tools, memory,
// approvals), and poll for the terminal result. Nothing here invents model
// output; a failed/cancelled/timed-out run rejects and the autotalk sweep
// skips that chat until the next tick.

import { randomUUID } from "node:crypto";
import type { KernelRepository, RunEngine } from "@companion/kernel";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 200;
const TERMINAL: Record<string, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  abandoned: true,
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export interface MainAgentChatInput {
  readonly chatId: string;
  readonly personaName: string;
  readonly text: string;
  readonly transcript: string;
}

export function createMainAgentChat(options: {
  repo: KernelRepository;
  engine: RunEngine;
  now: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): (input: MainAgentChatInput) => Promise<string> {
  const { repo, engine, now } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return async (input) => {
    if (engine.isDraining() || engine.isStopped()) {
      throw new Error("main_agent_unavailable");
    }
    const session = repo.createSession({
      // chat ids are UUID v4; reusing one keeps a single main session per chat.
      key: input.chatId,
      now: now(),
    });
    const sessionId = session.body.sessionId;
    const fresh = repo.getSession(sessionId).nextTurnPosition === 1;
    const prompt =
      fresh && input.transcript.length > 0
        ? [
            `あなたは「メインAI」として「${input.personaName}」と会話しています。`,
            "以下の会話の続きとして、あなた自身の発言を1つだけ返してください。",
            "",
            input.transcript,
            "",
            `${input.personaName}: ${input.text}`,
          ].join("\n")
        : `${input.personaName}: ${input.text}`;

    const posted = repo.postMessage(
      sessionId,
      { text: prompt },
      { key: randomUUID(), now: now() },
    );
    const runId = posted.body.run.id;
    engine.pump();

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = repo.getRun(runId);
      if (run.status === "completed") {
        const result = run.result;
        if (
          result !== null &&
          "text" in result &&
          typeof result.text === "string" &&
          result.text.length > 0
        ) {
          return result.text;
        }
        throw new Error("main_agent_no_text");
      }
      if (TERMINAL[run.status] === true) {
        throw new Error(`main_agent_${run.status}`);
      }
      if (Date.now() >= deadline) {
        engine.cancel(sessionId, runId);
        throw new Error("main_agent_timeout");
      }
      await sleep(pollMs);
    }
  };
}
