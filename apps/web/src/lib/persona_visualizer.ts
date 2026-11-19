// Pure layout and dialogue-stage visualization helpers for `/chats` & `/personas`.
//
// Strict CSP (`style-src 'self'`): all dynamic geometry is expressed as
// numeric SVG attributes (`x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `d`,
// `x1`, `y1`, `x2`, `y2`, `stroke-width`) and semantic `data-*` attributes —
// never inline CSS `style` strings.

import {
  type ChatMessage,
  type ChatSummary,
  type Persona,
  type PersonaProviderInfo,
  previewOf,
} from "./persona_chat.js";
import { personaAiLabel, providerLabel } from "./persona_display.js";

export const MAIN_PARTNER_ID = "__main__";
export const MAIN_DISPLAY_NAME = "メインAI";
export const MAIN_DISPLAY_AVATAR = "🜲";
export const USER_DISPLAY_NAME = "あなた";
export const USER_DISPLAY_AVATAR = "🧑";

export type ConstellationRole = "primary" | "partner" | "both" | "idle";

export interface PersonaConstellationNode {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly avatar: string;
  readonly aiLabel: string;
  readonly available: boolean;
  readonly isMain: boolean;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly role: ConstellationRole;
  readonly chatCount: number;
  readonly soloChatCount: number;
  readonly latestSoloChatId: string | null;
  readonly autotalkCount: number;
}

export interface PersonaConstellationEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly chatId: string;
  readonly title: string;
  readonly chatCount: number;
  readonly messageCount: number;
  readonly autotalk: boolean;
  readonly active: boolean;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly strokeWidth: number;
}

export interface PersonaPairingBeam {
  readonly fromId: string;
  readonly toId: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly midX: number;
  readonly midY: number;
  readonly existingChatId: string | null;
}

export interface PersonaConstellationLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PersonaConstellationNode[];
  readonly edges: readonly PersonaConstellationEdge[];
  readonly pairingBeam: PersonaPairingBeam | null;
}

export const CONSTELLATION_WIDTH = 640;
export const CONSTELLATION_HEIGHT = 250;

function truncateCodePoints(text: string, max = 10): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Deterministic radial/elliptical constellation of Personas (plus メインAI when
 * available), with curved edges for existing paired conversations and a live
 * preview beam for the currently selected `(pickerId, partnerId)` pair.
 */
export function buildPersonaConstellation(opts: {
  readonly personas: readonly Persona[];
  readonly chats: readonly ChatSummary[];
  readonly providers: readonly PersonaProviderInfo[];
  readonly mainAvailable: boolean;
  readonly pickerId: string;
  readonly partnerId: string;
  readonly selectedChatId: string | null;
}): PersonaConstellationLayout {
  const {
    personas,
    chats,
    providers,
    mainAvailable,
    pickerId,
    partnerId,
    selectedChatId,
  } = opts;

  const rawActors: {
    id: string;
    name: string;
    avatar: string;
    aiLabel: string;
    available: boolean;
    isMain: boolean;
  }[] = [];

  if (mainAvailable) {
    rawActors.push({
      id: MAIN_PARTNER_ID,
      name: MAIN_DISPLAY_NAME,
      avatar: MAIN_DISPLAY_AVATAR,
      aiLabel: "エージェント · 記憶・ツール",
      available: true,
      isMain: true,
    });
  }

  for (const p of personas) {
    const prov = providers.find((x) => x.id === p.provider);
    rawActors.push({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      aiLabel: personaAiLabel(providers, p),
      available: prov?.available === true,
      isMain: false,
    });
  }

  const total = rawActors.length;
  const cx = CONSTELLATION_WIDTH / 2;
  const cy = CONSTELLATION_HEIGHT / 2 + 4;
  const rx = total <= 2 ? 150 : 220;
  const ry = total <= 2 ? 56 : 82;

  // Count chats per actor & solo chats (1-on-1 user chats with no partner).
  const chatCountById = new Map<string, number>();
  const soloChatsById = new Map<string, ChatSummary[]>();
  const autotalkById = new Map<string, number>();

  for (const c of chats) {
    chatCountById.set(c.personaId, (chatCountById.get(c.personaId) ?? 0) + 1);
    if (c.autotalk) {
      autotalkById.set(c.personaId, (autotalkById.get(c.personaId) ?? 0) + 1);
    }
    const p2 = c.partnerMain
      ? MAIN_PARTNER_ID
      : c.partnerId !== null && c.partnerId.length > 0
        ? c.partnerId
        : null;
    if (p2 !== null) {
      chatCountById.set(p2, (chatCountById.get(p2) ?? 0) + 1);
      if (c.autotalk) {
        autotalkById.set(p2, (autotalkById.get(p2) ?? 0) + 1);
      }
    } else {
      const list = soloChatsById.get(c.personaId) ?? [];
      list.push(c);
      soloChatsById.set(c.personaId, list);
    }
  }

  const nodes: PersonaConstellationNode[] = rawActors.map((actor, idx) => {
    let x = cx;
    let y = cy;
    if (total === 1) {
      x = cx;
      y = cy;
    } else if (total === 2) {
      x = idx === 0 ? cx - 140 : cx + 140;
      y = cy;
    } else {
      const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / total;
      x = Math.round(cx + Math.cos(angle) * rx);
      y = Math.round(cy + Math.sin(angle) * ry);
    }
    const isPrimary = pickerId === actor.id;
    const isPartner = partnerId === actor.id && partnerId !== "";
    const role: ConstellationRole =
      isPrimary && isPartner
        ? "both"
        : isPrimary
          ? "primary"
          : isPartner
            ? "partner"
            : "idle";
    const solos = soloChatsById.get(actor.id) ?? [];
    return {
      id: actor.id,
      name: actor.name,
      shortName: truncateCodePoints(actor.name, 10),
      avatar: actor.avatar,
      aiLabel: truncateCodePoints(actor.aiLabel, 18),
      available: actor.available,
      isMain: actor.isMain,
      x,
      y,
      r: actor.isMain ? 25 : 23,
      role,
      chatCount: chatCountById.get(actor.id) ?? 0,
      soloChatCount: solos.length,
      latestSoloChatId: solos[0]?.id ?? null,
      autotalkCount: autotalkById.get(actor.id) ?? 0,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Group paired chats by unordered pair key.
  const pairGroups = new Map<
    string,
    { a: string; b: string; chats: ChatSummary[] }
  >();
  for (const c of chats) {
    const targetB = c.partnerMain
      ? MAIN_PARTNER_ID
      : c.partnerId !== null && c.partnerId.length > 0
        ? c.partnerId
        : null;
    if (targetB === null || targetB === c.personaId) continue;
    if (!nodeById.has(c.personaId) || !nodeById.has(targetB)) continue;
    const a = c.personaId < targetB ? c.personaId : targetB;
    const b = c.personaId < targetB ? targetB : c.personaId;
    const key = `${a}::${b}`;
    const existing = pairGroups.get(key);
    if (existing !== undefined) {
      existing.chats.push(c);
    } else {
      pairGroups.set(key, { a, b, chats: [c] });
    }
  }

  const edges: PersonaConstellationEdge[] = [];
  for (const [key, group] of pairGroups) {
    const nA = nodeById.get(group.a);
    const nB = nodeById.get(group.b);
    if (nA === undefined || nB === undefined) continue;
    const sorted = [...group.chats].sort((x, y) => y.updatedAt - x.updatedAt);
    const latest = sorted[0];
    if (latest === undefined) continue;
    const messageCount = group.chats.reduce(
      (acc, c) => acc + (c.messageCount ?? 0),
      0,
    );
    const autotalk = group.chats.some((c) => c.autotalk);
    const active =
      selectedChatId !== null &&
      group.chats.some((c) => c.id === selectedChatId);

    // Slight curve towards the center of the canvas so chords remain distinct.
    const mx = (nA.x + nB.x) / 2;
    const my = (nA.y + nB.y) / 2;
    const ctrlX = Math.round(mx + (cx - mx) * 0.28);
    const ctrlY = Math.round(my + (cy - my) * 0.28);
    const labelX = Math.round(0.25 * nA.x + 0.5 * ctrlX + 0.25 * nB.x);
    const labelY = Math.round(0.25 * nA.y + 0.5 * ctrlY + 0.25 * nB.y);
    const strokeWidth = Math.min(
      6,
      2 + Math.floor(Math.log2(Math.max(1, messageCount) + 1)),
    );

    edges.push({
      id: key,
      fromId: group.a,
      toId: group.b,
      chatId: latest.id,
      title: latest.title,
      chatCount: group.chats.length,
      messageCount,
      autotalk,
      active,
      path: `M ${nA.x} ${nA.y} Q ${ctrlX} ${ctrlY} ${nB.x} ${nB.y}`,
      labelX,
      labelY,
      strokeWidth,
    });
  }

  let pairingBeam: PersonaPairingBeam | null = null;
  if (pickerId !== "" && partnerId !== "" && pickerId !== partnerId) {
    const n1 = nodeById.get(pickerId);
    const n2 = nodeById.get(partnerId);
    if (n1 !== undefined && n2 !== undefined) {
      const a = pickerId < partnerId ? pickerId : partnerId;
      const b = pickerId < partnerId ? partnerId : pickerId;
      const existing = pairGroups.get(`${a}::${b}`)?.chats[0]?.id ?? null;
      pairingBeam = {
        fromId: pickerId,
        toId: partnerId,
        x1: n1.x,
        y1: n1.y,
        x2: n2.x,
        y2: n2.y,
        midX: Math.round((n1.x + n2.x) / 2),
        midY: Math.round((n1.y + n2.y) / 2),
        existingChatId: existing,
      };
    }
  } else if (pickerId !== "" && partnerId === "") {
    const n1 = nodeById.get(pickerId);
    if (n1 !== undefined) {
      const solos = soloChatsById.get(pickerId) ?? [];
      pairingBeam = {
        fromId: pickerId,
        toId: "",
        x1: n1.x,
        y1: n1.y,
        x2: n1.x,
        y2: n1.y,
        midX: n1.x,
        midY: n1.y,
        existingChatId: solos[0]?.id ?? null,
      };
    }
  }

  return {
    width: CONSTELLATION_WIDTH,
    height: CONSTELLATION_HEIGHT,
    nodes,
    edges,
    pairingBeam,
  };
}

export type SpeakerSlot = "primary" | "partner" | "user";

export interface DialogueActorStat {
  readonly slot: SpeakerSlot;
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly aiLabel: string;
  readonly turnCount: number;
  readonly charCount: number;
  readonly sharePct: number;
  readonly isLastSpeaker: boolean;
  readonly isGenerating: boolean;
}

export interface TurnTimelineBar {
  readonly id: string;
  readonly index: number;
  readonly slot: SpeakerSlot;
  readonly speakerName: string;
  readonly speakerAvatar: string;
  readonly preview: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TurnBalanceSegment {
  readonly slot: SpeakerSlot;
  readonly label: string;
  readonly count: number;
  readonly x: number;
  readonly width: number;
}

export interface DialogueStageModel {
  readonly primary: DialogueActorStat;
  readonly secondary: DialogueActorStat;
  readonly userInterventions: number;
  readonly totalTurns: number;
  readonly isPairChat: boolean;
  readonly timelineWidth: number;
  readonly timelineHeight: number;
  readonly turnBars: readonly TurnTimelineBar[];
  readonly balanceSegments: readonly TurnBalanceSegment[];
}

export const TIMELINE_SVG_WIDTH = 560;
export const TIMELINE_SVG_HEIGHT = 40;
export const BALANCE_SVG_WIDTH = 200;

export function classifyMessageSlot(
  m: ChatMessage,
  chat: ChatSummary,
): SpeakerSlot {
  if (m.role === "user") return "user";
  if (m.personaId === null && chat.partnerMain) return "partner";
  if (
    chat.partnerId !== null &&
    m.personaId !== null &&
    m.personaId === chat.partnerId
  ) {
    return "partner";
  }
  return "primary";
}

export function buildDialogueStage(opts: {
  readonly chat: ChatSummary;
  readonly messages: readonly ChatMessage[];
  readonly personas: readonly Persona[];
  readonly providers: readonly PersonaProviderInfo[];
  readonly sending: boolean;
}): DialogueStageModel {
  const { chat, messages, personas, providers, sending } = opts;
  const isPairChat = chat.partnerMain || chat.partnerId !== null;
  const primaryPersona = personas.find((p) => p.id === chat.personaId);
  const partnerPersona =
    chat.partnerId !== null
      ? personas.find((p) => p.id === chat.partnerId)
      : undefined;

  const primaryAiLabel =
    primaryPersona !== undefined
      ? personaAiLabel(providers, primaryPersona)
      : providerLabel(providers, chat.provider);

  const secondarySlot: SpeakerSlot = isPairChat ? "partner" : "user";
  const secondaryId = chat.partnerMain
    ? MAIN_PARTNER_ID
    : (chat.partnerId ?? "__user__");
  const secondaryName = chat.partnerMain
    ? MAIN_DISPLAY_NAME
    : (chat.partnerName ?? USER_DISPLAY_NAME);
  const secondaryAvatar = chat.partnerMain
    ? MAIN_DISPLAY_AVATAR
    : (chat.partnerAvatar ?? USER_DISPLAY_AVATAR);
  const secondaryAiLabel = chat.partnerMain
    ? "メインAI · 記憶・ツール"
    : partnerPersona !== undefined
      ? personaAiLabel(providers, partnerPersona)
      : isPairChat
        ? "パートナーAI"
        : "ユーザー発言";

  let primaryTurns = 0;
  let primaryChars = 0;
  let partnerTurns = 0;
  let partnerChars = 0;
  let userTurns = 0;
  let userChars = 0;

  const slots: SpeakerSlot[] = [];
  for (const m of messages) {
    const slot = classifyMessageSlot(m, chat);
    slots.push(slot);
    const len = Array.from(m.content).length;
    if (slot === "primary") {
      primaryTurns += 1;
      primaryChars += len;
    } else if (slot === "partner") {
      partnerTurns += 1;
      partnerChars += len;
    } else {
      userTurns += 1;
      userChars += len;
    }
  }

  const lastSlot = slots.length > 0 ? (slots[slots.length - 1] ?? null) : null;
  const secondaryTurns = isPairChat ? partnerTurns : userTurns;
  const secondaryChars = isPairChat ? partnerChars : userChars;
  const denom = Math.max(1, primaryTurns + secondaryTurns);

  const primary: DialogueActorStat = {
    slot: "primary",
    id: chat.personaId,
    name: chat.personaName,
    avatar: chat.avatar,
    aiLabel: primaryAiLabel,
    turnCount: primaryTurns,
    charCount: primaryChars,
    sharePct:
      messages.length === 0 ? 50 : Math.round((primaryTurns / denom) * 100),
    isLastSpeaker: lastSlot === "primary",
    isGenerating: sending,
  };

  const secondary: DialogueActorStat = {
    slot: secondarySlot,
    id: secondaryId,
    name: secondaryName,
    avatar: secondaryAvatar,
    aiLabel: secondaryAiLabel,
    turnCount: secondaryTurns,
    charCount: secondaryChars,
    sharePct:
      messages.length === 0 ? 50 : Math.round((secondaryTurns / denom) * 100),
    isLastSpeaker: lastSlot === secondarySlot,
    isGenerating: false,
  };

  // Turn timeline bars across TIMELINE_SVG_WIDTH.
  const count = messages.length;
  const turnBars: TurnTimelineBar[] = [];
  if (count > 0) {
    const gap = count > 40 ? 1 : 2;
    const barW = Math.max(
      3,
      (TIMELINE_SVG_WIDTH - gap * Math.max(0, count - 1)) / count,
    );
    for (let i = 0; i < count; i += 1) {
      const m = messages[i];
      const slot = slots[i];
      if (m === undefined || slot === undefined) continue;
      const charLen = Math.max(1, Array.from(m.content).length);
      const norm = Math.min(1, Math.log2(charLen + 1) / 10);
      const h = Math.round(10 + norm * (TIMELINE_SVG_HEIGHT - 14));
      const x = Number((i * (barW + gap)).toFixed(2));
      const y = TIMELINE_SVG_HEIGHT - h - 2;
      const speakerName =
        slot === "primary"
          ? primary.name
          : slot === "partner"
            ? secondary.name
            : USER_DISPLAY_NAME;
      const speakerAvatar =
        slot === "primary"
          ? primary.avatar
          : slot === "partner"
            ? secondary.avatar
            : USER_DISPLAY_AVATAR;
      turnBars.push({
        id: m.id,
        index: i + 1,
        slot,
        speakerName,
        speakerAvatar,
        preview: previewOf(m.content, 32),
        x,
        y,
        width: Number(Math.max(2, barW).toFixed(2)),
        height: h,
      });
    }
  }

  // Balance segments across BALANCE_SVG_WIDTH.
  const balanceRaw: { slot: SpeakerSlot; label: string; count: number }[] = [
    { slot: "primary", label: primary.name, count: primaryTurns },
    ...(isPairChat
      ? [
          {
            slot: "partner" as const,
            label: secondary.name,
            count: partnerTurns,
          },
          ...(userTurns > 0
            ? [
                {
                  slot: "user" as const,
                  label: USER_DISPLAY_NAME,
                  count: userTurns,
                },
              ]
            : []),
        ]
      : [
          {
            slot: "user" as const,
            label: USER_DISPLAY_NAME,
            count: userTurns,
          },
        ]),
  ];
  const totalBalance = balanceRaw.reduce((acc, s) => acc + s.count, 0);
  const balanceSegments: TurnBalanceSegment[] = [];
  if (totalBalance > 0) {
    let curX = 0;
    for (const seg of balanceRaw) {
      if (seg.count <= 0) continue;
      const w = (seg.count / totalBalance) * BALANCE_SVG_WIDTH;
      balanceSegments.push({
        slot: seg.slot,
        label: seg.label,
        count: seg.count,
        x: Number(curX.toFixed(2)),
        width: Number(Math.max(2, w).toFixed(2)),
      });
      curX += w;
    }
  }

  return {
    primary,
    secondary,
    userInterventions: isPairChat ? userTurns : 0,
    totalTurns: messages.length,
    isPairChat,
    timelineWidth: TIMELINE_SVG_WIDTH,
    timelineHeight: TIMELINE_SVG_HEIGHT,
    turnBars,
    balanceSegments,
  };
}
