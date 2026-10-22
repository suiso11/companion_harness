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
  {
    path: "/monitor",
    label: "モニター",
    sectionId: "monitor",
    title: "モニター",
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

/**
 * Learning evidence source kind → path of the feature route that owns the
 * referenced record (review fix: the /learning page mounts only ChatPage +
 * LearningPanel, so in-page section scrolling can never reach the source).
 * Keep the values in sync with FEATURE_ROUTES paths above.
 */
export const SOURCE_ROUTES: Record<string, string> = {
  shadow_job: "/shadow",
  conversation_proposal: "/proposals",
  action_receipt: "/tasks",
  task_event: "/tasks",
};

/**
 * Full-page navigation to a feature route with a record hash. Routes are
 * real server routes (full page loads, see App.svelte), so `location.assign`
 * is the router navigation primitive here.
 */
export function navigateToHash(path: string, recordId: string): void {
  try {
    location.assign(`${path}#${encodeURIComponent(recordId)}`);
  } catch {
    // Navigation is best effort; never break the calling drawer.
  }
}

// Deep-link reveal: feature pages scroll/focus the element whose id matches
// the location hash once the owning list has loaded (retry until render).
let hashRevealed = false;
let hashAttempts = 0;

export function revealHashTarget(): void {
  if (hashRevealed) return;
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  const recordId = decodeURIComponent(raw);
  if (recordId === "") {
    hashRevealed = true;
    return;
  }
  const target = document.getElementById(recordId);
  if (target === null) {
    // Not rendered yet (list still loading): retry shortly, give up ~5s.
    if (hashAttempts < 25) {
      hashAttempts += 1;
      window.setTimeout(revealHashTarget, 200);
    }
    return;
  }
  hashRevealed = true;
  try {
    target.scrollIntoView();
    if (typeof target.focus === "function")
      target.focus({ preventScroll: true });
  } catch {
    // Best effort: navigation never breaks the page.
  }
}
