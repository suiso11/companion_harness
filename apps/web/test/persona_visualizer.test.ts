import { describe, expect, test } from "vitest";
import type {
  ChatMessage,
  ChatSummary,
  Persona,
  PersonaProviderInfo,
} from "../src/lib/persona_chat.js";
import {
  buildDialogueStage,
  buildPersonaConstellation,
  MAIN_PARTNER_ID,
} from "../src/lib/persona_visualizer.js";

const PROVIDERS: PersonaProviderInfo[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    suggestedModels: ["deepseek-chat"],
    available: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    suggestedModels: ["gpt-4o"],
    available: true,
  },
];

const PERSONAS: Persona[] = [
  {
    id: "p-aoi",
    name: "葵",
    avatar: "🌙",
    provider: "deepseek",
    model: "deepseek-chat",
    systemPrompt: "静かな司書",
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: "p-ren",
    name: "蓮",
    avatar: "🔥",
    provider: "openai",
    model: "gpt-4o",
    systemPrompt: "熱血発明家",
    createdAt: 1000,
    updatedAt: 1000,
  },
];

const CHATS: ChatSummary[] = [
  {
    id: "chat-pair",
    personaId: "p-aoi",
    personaName: "葵",
    avatar: "🌙",
    provider: "deepseek",
    title: "夜の読書会",
    createdAt: 1000,
    updatedAt: 5000,
    preview: "次はこの本を読みましょう",
    messageCount: 12,
    partnerId: "p-ren",
    partnerMain: false,
    partnerName: "蓮",
    partnerAvatar: "🔥",
    autotalk: true,
  },
  {
    id: "chat-solo",
    personaId: "p-aoi",
    personaName: "葵",
    avatar: "🌙",
    provider: "deepseek",
    title: "個人相談",
    createdAt: 1000,
    updatedAt: 3000,
    preview: "こんにちは",
    messageCount: 4,
    partnerId: null,
    partnerMain: false,
    partnerName: null,
    partnerAvatar: null,
    autotalk: false,
  },
];

describe("persona_visualizer", () => {
  test("buildPersonaConstellation places personas, main AI, edges, and pairing beam", () => {
    const layout = buildPersonaConstellation({
      personas: PERSONAS,
      chats: CHATS,
      providers: PROVIDERS,
      mainAvailable: true,
      pickerId: "p-aoi",
      partnerId: "p-ren",
      selectedChatId: "chat-pair",
    });

    // Main AI + 2 personas = 3 nodes
    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes.find((n) => n.id === MAIN_PARTNER_ID)?.isMain).toBe(
      true,
    );
    const aoi = layout.nodes.find((n) => n.id === "p-aoi");
    const ren = layout.nodes.find((n) => n.id === "p-ren");
    expect(aoi?.role).toBe("primary");
    expect(aoi?.soloChatCount).toBe(1);
    expect(ren?.role).toBe("partner");

    // 1 paired edge between p-aoi and p-ren
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.autotalk).toBe(true);
    expect(layout.edges[0]?.active).toBe(true);
    expect(layout.edges[0]?.chatId).toBe("chat-pair");

    // Pairing beam connects p-aoi -> p-ren and finds existingChatId
    expect(layout.pairingBeam).not.toBeNull();
    expect(layout.pairingBeam?.existingChatId).toBe("chat-pair");
  });

  test("buildDialogueStage computes turn distribution, timeline bars, and balance segments", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "user",
        personaId: null,
        content: "二人で新しい発明の話をしてみて",
        createdAt: 1000,
      },
      {
        id: "m2",
        role: "assistant",
        personaId: "p-aoi",
        content: "まずは過去の文献を紐解きましょう。",
        createdAt: 2000,
      },
      {
        id: "m3",
        role: "assistant",
        personaId: "p-ren",
        content: "いや、まずは手を動かして試作機を作るべきだ！",
        createdAt: 3000,
      },
    ];

    const chat = CHATS[0] as ChatSummary;
    const stage = buildDialogueStage({
      chat,
      messages,
      personas: PERSONAS,
      providers: PROVIDERS,
      sending: false,
    });

    expect(stage.isPairChat).toBe(true);
    expect(stage.totalTurns).toBe(3);
    expect(stage.userInterventions).toBe(1);
    expect(stage.primary.turnCount).toBe(1);
    expect(stage.secondary.turnCount).toBe(1);
    expect(stage.secondary.isLastSpeaker).toBe(true);
    expect(stage.turnBars).toHaveLength(3);
    expect(stage.turnBars.map((b) => b.slot)).toEqual([
      "user",
      "primary",
      "partner",
    ]);
    expect(stage.balanceSegments).toHaveLength(3);
  });
});
