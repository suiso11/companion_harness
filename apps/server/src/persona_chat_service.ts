// Persona chat send path: stored history + persona prompt -> hosted provider
// -> one atomic user/assistant exchange. Fixed messages only; message text,
// prompts and API keys never reach logs or errors.

import {
  PERSONA_PROVIDER_CATALOG,
  type PersonaProvider,
  type PersonaProviderInfoSchema,
} from "@companion/contracts";
import type {
  ChatMessageRow,
  ChatSummaryRow,
  PersonaChatStore,
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
}

export function createPersonaChatService(options: {
  store: PersonaChatStore;
  keys: Readonly<{ openai: string | null; deepseek: string | null }>;
  now: () => number;
  /** Test seam: defaults to createRemoteGateway. */
  createGateway?: (input: {
    provider: PersonaProvider;
    model: string;
    apiKey: string;
  }) => { chat(request: RemoteChatRequest): Promise<RemoteChatResult> };
}): PersonaChatService {
  const { store, keys, now } = options;
  const createGateway = options.createGateway ?? createRemoteGateway;
  // Concurrent sends with the same clientKey share one model call; the store's
  // UNIQUE(chat_id, client_key) stays the cross-process backstop.
  const inFlight = new Map<string, Promise<PersonaChatExchange>>();

  return {
    providers: () =>
      PERSONA_PROVIDER_CATALOG.map((p) => ({
        id: p.id,
        label: p.label,
        suggestedModels: [...p.suggestedModels],
        available: keys[p.id] !== null,
      })),

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
        const apiKey = keys[persona.provider];
        if (apiKey === null) {
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
          const gateway = createGateway({
            provider: persona.provider,
            model: persona.model,
            apiKey,
          });
          reply = (
            await gateway.chat({
              messages,
              maxOutputTokens: 1024,
              temperature: 0.8,
            })
          ).text;
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
