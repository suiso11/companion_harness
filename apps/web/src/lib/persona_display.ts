import type { PersonaProvider, PersonaProviderInfo } from "./persona_chat.js";

/** Catalog label for a provider id; unknown ids fall back to the raw id. */
export function providerLabel(
  providers: readonly PersonaProviderInfo[],
  id: PersonaProvider,
): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

/** "DeepSeek · deepseek-flash": which AI a persona talks through. */
export function personaAiLabel(
  providers: readonly PersonaProviderInfo[],
  persona: { readonly provider: PersonaProvider; readonly model: string },
): string {
  return `${providerLabel(providers, persona.provider)} · ${persona.model}`;
}

/** "DeepSeek × OpenCode Zen" for a two-persona chat, else one label. */
export function pairAiLabel(
  providers: readonly PersonaProviderInfo[],
  primary: PersonaProvider,
  partner: PersonaProvider | null,
): string {
  const first = providerLabel(providers, primary);
  return partner === null
    ? first
    : `${first} × ${providerLabel(providers, partner)}`;
}
