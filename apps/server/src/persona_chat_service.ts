// Persona chat send path: stored history + persona prompt -> hosted provider
// -> one atomic user/assistant exchange. Fixed messages only; message text,
// prompts and API keys never reach logs or errors.

import {
  type HostedPersonaProvider,
  PERSONA_PROVIDER_CATALOG,
  type PersonaProviderInfoSchema,
} from "@companion/contracts";
import type {
  ChatMessageRow,
  ChatSummaryRow,
  PersonaChatStore,
  PersonaRow,
} from "@companion/kernel";
import {
  createRemoteGateway,
  type RemoteChatMessage,
  type RemoteChatRequest,
  type RemoteChatResult,
} from "@companion/model-remote";
import type { z } from "zod";

export type PersonaProviderInfo = z.infer<typeof PersonaProviderInfoSchema>;

/** Newest stored messages replayed to the provider as context. */
export const PERSONA_CHAT_HISTORY_LIMIT = 20;
/** An autotalk chat is due once its newest message is this old. */
export const AUTOTALK_INTERVAL_MS = 3_600_000;
const AUTOTALK_BATCH = 10;
const AUTOTALK_PROMPT =
  "直前の流れに続く短い一言だけを返してください。前置きや説明は不要です。";
const AUTOTALK_START_PROMPT = "会話を始めてください。";

type ErrorCode =
  | "chat_not_found"
  | "persona_not_found"
  | "provider_unavailable"
  | "provider_failed";

const MESSAGES: Record<ErrorCode, string> = {
  chat_not_found: "chat not found",
  persona_not_found: "persona not found",
  provider_unavailable: "provider unavailable",
  provider_failed: "provider request failed",
};

export class PersonaChatServiceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(MESSAGES[code]);
    this.name = "PersonaChatServiceError";
    this.code = code;
  }
}

export interface PersonaChatExchange {
  readonly chat: ChatSummaryRow;
  readonly messages: {
    readonly user: ChatMessageRow;
    readonly assistant: ChatMessageRow;
  };
}

export interface PersonaChatService {
  providers(): PersonaProviderInfo[];
  send(input: {
    chatId: string;
    text: string;
    clientKey?: string;
  }): Promise<PersonaChatExchange>;
  /**
   * One autotalk pass over due chats; resolves with the number of messages
   * written. Never rejects: a failing chat is skipped until the next pass.
   */
  autotalk(nowMs: number): Promise<number>;
}

export function createPersonaChatService(options: {
  store: PersonaChatStore;
  /**
   * Live key map (env or the settings-page store). Read on every call so a
   * runtime key change applies without rebuilding the service.
   */
  keys: Readonly<Record<HostedPersonaProvider, string | null>>;
  now: () => number;
  /** Test seam: defaults to createRemoteGateway. */
  createGateway?: (input: {
    provider: HostedPersonaProvider;
    model: string;
    apiKey: string;
  }) => { chat(request: RemoteChatRequest): Promise<RemoteChatResult> };
  /** Server-configured local model; absent marks the `local` provider unavailable. */
  localChat?: (
    messages: readonly RemoteChatMessage[],
    maxOutputTokens: number,
  ) => Promise<string>;
  /**
   * Background admission for a LOCAL autotalk turn (the local model is shared
   * with foreground chat). Returns a release or null when busy; hosted turns
   * never acquire it.
   */
  acquireLocal?: () => (() => void) | null;
}): PersonaChatService {
  const { store, keys, now, localChat, acquireLocal } = options;
  const createGateway = options.createGateway ?? createRemoteGateway;
  // Concurrent sends with the same clientKey share one model call; the store's
  // UNIQUE(chat_id, client_key) stays the cross-process backstop.
  const inFlight = new Map<string, Promise<PersonaChatExchange>>();
  const autotalkRunning = new Set<string>();

  /** One model call for this persona's provider; null when it is unavailable. */
  const providerCall = (
    persona: PersonaRow,
  ): ((messages: RemoteChatMessage[]) => Promise<string>) | null => {
    const { provider, model } = persona;
    if (provider === "local") {
      return localChat === undefined
        ? null
        : (messages) => localChat(messages, 1024);
    }
    const apiKey = keys[provider];
    if (apiKey === null) return null;
    return async (messages) =>
      (
        await createGateway({
          provider,
          model,
          apiKey,
        }).chat({ messages, maxOutputTokens: 1024 })
      ).text;
  };

  async function autotalkOne(chat: ChatSummaryRow): Promise<boolean> {
    const { partnerId } = chat;
    if (partnerId === null) return false;
    const history = store.listMessages(chat.id, {
      limit: PERSONA_CHAT_HISTORY_LIMIT,
    }).messages;
    const newest = history.filter((m) => m.personaId !== null).at(-1);
    const speakerId =
      newest === undefined || newest.personaId === partnerId
        ? chat.personaId
        : partnerId;
    const otherId = speakerId === chat.personaId ? partnerId : chat.personaId;
    const speaker = store.getPersona(speakerId);
    const other = store.getPersona(otherId);
    if (speaker === null || other === null) return false;
    const call = providerCall(speaker);
    if (call === null) return false;
    const gate = speaker.provider === "local" ? acquireLocal : undefined;
    const release = gate === undefined ? null : gate();
    if (gate !== undefined && release === null) return false;
    try {
      const reply = await call([
        {
          role: "system",
          content: `${speaker.systemPrompt}\n会話の相手は${other.name}です。`,
        },
        ...history.map((m) => ({
          role:
            m.personaId === speakerId
              ? ("assistant" as const)
              : ("user" as const),
          content: m.content,
        })),
        {
          role: "user",
          content:
            history.length === 0 ? AUTOTALK_START_PROMPT : AUTOTALK_PROMPT,
        },
      ]);
      store.appendParticipantMessage(chat.id, speakerId, reply, now());
      return true;
    } finally {
      release?.();
    }
  }

  return {
    providers: () =>
      PERSONA_PROVIDER_CATALOG.map((p) => ({
        id: p.id,
        label: p.label,
        suggestedModels: [...p.suggestedModels],
        available:
          p.id === "local" ? localChat !== undefined : keys[p.id] !== null,
      })),

    async autotalk(nowMs) {
      let written = 0;
      try {
        const due = store.listAutotalkDue(
          nowMs - AUTOTALK_INTERVAL_MS,
          AUTOTALK_BATCH,
        );
        for (const chat of due) {
          if (autotalkRunning.has(chat.id)) continue;
          autotalkRunning.add(chat.id);
          try {
            if (await autotalkOne(chat)) written += 1;
          } catch {
            // Skipped: nothing was appended; the chat stays due for the next pass.
          } finally {
            autotalkRunning.delete(chat.id);
          }
        }
      } catch {
        // Store failure: nothing to report to the timer caller.
      }
      return written;
    },

    send({ chatId, text, clientKey }) {
      const chat = store.getChat(chatId);
      if (!chat) {
        return Promise.reject(new PersonaChatServiceError("chat_not_found"));
      }

      if (clientKey !== undefined) {
        const replay = store.findExchangeByClientKey(chatId, clientKey);
        if (replay) return Promise.resolve({ chat, messages: replay });
      }

      const dedupeKey =
        clientKey === undefined ? null : `${chatId}:${clientKey}`;
      if (dedupeKey !== null) {
        const running = inFlight.get(dedupeKey);
        if (running !== undefined) return running;
      }

      const run = (async () => {
        const persona = store.getPersona(chat.personaId);
        if (!persona) throw new PersonaChatServiceError("persona_not_found");
        const call = providerCall(persona);
        if (call === null) {
          throw new PersonaChatServiceError("provider_unavailable");
        }

        const history = store.listMessages(chatId, {
          limit: PERSONA_CHAT_HISTORY_LIMIT,
        }).messages;
        const messages: RemoteChatMessage[] = [
          { role: "system", content: persona.systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: text },
        ];

        let reply: string;
        try {
          reply = await call(messages);
        } catch {
          throw new PersonaChatServiceError("provider_failed");
        }

        let exchange: PersonaChatExchange["messages"];
        try {
          exchange = store.appendExchange(
            chatId,
            { text, reply, ...(clientKey !== undefined ? { clientKey } : {}) },
            now(),
          );
        } catch (error) {
          // Another process won the same clientKey: return its exchange.
          if (clientKey === undefined) throw error;
          const replay = store.findExchangeByClientKey(chatId, clientKey);
          if (replay === null) throw error;
          return { chat: store.getChat(chatId) ?? chat, messages: replay };
        }
        const fresh = store.getChat(chatId);
        if (!fresh) throw new PersonaChatServiceError("chat_not_found");
        return { chat: fresh, messages: exchange };
      })();

      if (dedupeKey !== null) {
        inFlight.set(dedupeKey, run);
        const clear = () => inFlight.delete(dedupeKey);
        run.then(clear, clear);
      }
      return run;
    },
  };
}
