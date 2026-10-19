/// <reference lib="dom" />
// PR-5: feature pages beyond chat (frontend plan §12 PR-5, Q8).
//
// Simple history routes served by the Hono app: every feature route returns
// the same Svelte shell, and the client picks the page from `location.pathname`.
// The nav is intentionally slim (one link per surface) and Japanese- only
// (Q7). Chat stays the default route `/`.

export interface FeatureRoute {
  readonly path: string;
  readonly label: string;
  /** Legacy section id mounted by the feature page. */
  readonly sectionId: string;
  readonly title: string;
}

/** Nav order mirrors the legacy shell order (memory → autonomy → …). */
export const FEATURE_ROUTES: readonly FeatureRoute[] = [
  {
    path: "/memory",
    label: "記憶",
    sectionId: "memory",
    title: "記憶の管理",
  },
  {
    path: "/tasks",
    label: "タスク・目的",
    sectionId: "autonomy",
    title: "タスク・目的",
  },
  {
    path: "/notifications",
    label: "通知",
    sectionId: "notifications",
    title: "お知らせ",
  },
  {
    path: "/trials",
    label: "試行の提案",
    sectionId: "trials",
    title: "試行の提案",
  },
  {
    path: "/learning",
    label: "学び",
    sectionId: "learning",
    title: "学びの記録",
  },
  {
    path: "/shadow",
    label: "試行",
    sectionId: "shadow",
    title: "試行の記録",
  },
  {
    path: "/proposals",
    label: "候補",
    sectionId: "proposals",
    title: "会話の候補",
  },
  {
    path: "/handoff",
    label: "引継ぎ",
    sectionId: "handoff",
    title: "引継ぎ",
  },
];

/** Feature section ids hidden on a page (chat stays visible for context). */
export function hiddenSectionIds(active: FeatureRoute): string[] {
  return FEATURE_ROUTES.filter((route) => route.path !== active.path).map(
    (route) => route.sectionId,
  );
}

/** Normalizes the trailing slash so `/memory/` and `/memory` match. */
export function routeForPath(pathname: string): FeatureRoute | null {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return FEATURE_ROUTES.find((route) => route.path === normalized) ?? null;
}
