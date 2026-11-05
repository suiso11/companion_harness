import { fetchJson } from "./api.js";

// Local mirrors of the persona-chat API payloads (server: /api/personas, /api/chats)
// plus pure display helpers shared by ChatsPage and PersonasPage.

export type PersonaProvider = "openai" | "deepseek";

export interface Persona {
  id: string;
  name: string;
  avatar: string;
  provider: PersonaProvider;
  model: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaProviderInfo {
  id: PersonaProvider;
  label: string;
  suggestedModels: string[];
  available: boolean;
}

export interface ChatSummary {
  id: string;
  personaId: string;
  personaName: string;
  avatar: string;
  provider: PersonaProvider;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** Japanese relative time; epoch milliseconds in, "たった今" under a minute. */
export function relativeTime(now: number, then: number): string {
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  return new Date(then).toLocaleDateString("ja-JP");
}

/** One-line preview: whitespace collapsed, cut to `max` code points. */
export function previewOf(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

// Persona routes take no Idempotency-Key. Kept out of lib/api.ts (which sits
// in the entry chunk) so the entry bundle does not grow.
export function patchJson(path: string, body: unknown) {
  return fetchJson(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteJson(path: string) {
  return fetchJson(path, { method: "DELETE" });
}
