<script lang="ts">
import { onMount } from "svelte";
import {
  FEATURE_ROUTES,
  type FeatureRoute,
  hiddenSectionIds,
} from "./lib/router.js";

// PR-5: non-chat surfaces live on their own history routes. The server
// returns the same Svelte shell for every route (auth + strict CSP stay
// identical), and this component mounts the existing legacy feature surface
// with its exact DOM ids / API wiring. The chat page (`/`) stays the Svelte
// implementation and is not affected: C22 approval code is untouched.
//
// Why mount the legacy surface instead of duplicating the wiring? The
// feature panels (memory search/correct/retire, autonomy purposes/tasks,
// learning evidence, shadow trials, proposals, handoffs, notifications) are
// backed by ~6k lines of behaviorally pinned DOM logic. Mounting the same
// surface guarantees the same APIs and DOM test ids, and the e2e specs only
// change their `page.goto` target. Other feature sections are hidden on the
// active route so each page is a single feature.

let { route }: { route: FeatureRoute } = $props();

let container: HTMLDivElement | null = $state(null);
let error = $state("");

let injected: HTMLElement[] = [];

function addStylesheet(): void {
  const id = "legacy-feature-css";
  if (document.getElementById(id) !== null) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = "/assets/client.css";
  document.head.append(link);
  injected.push(link);
}

function addClient(): void {
  const id = "legacy-feature-js";
  if (document.getElementById(id) !== null) return;
  const script = document.createElement("script");
  script.id = id;
  script.src = "/assets/client.js";
  script.defer = true;
  document.body.append(script);
  injected.push(script);
}

async function mountSurface(): Promise<void> {
  if (container === null) return;
  try {
    const response = await fetch("/legacy", {
      credentials: "same-origin",
      headers: { accept: "text/html" },
    });
    if (!response.ok) {
      error = "ページを読み込めませんでした";
      return;
    }
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const body = parsed.body;
    // Scripts are never imported from the fetched shell: the bundle is
    // loaded once by addClient() below. The SSR login form has no body
    // children (no #conversation), so an unauthenticated remote browser
    // gets the inline login shell from the server instead of this page.
    for (const script of [...body.querySelectorAll("script")]) {
      script.remove();
    }
    if (body.querySelector("#conversation") === null) {
      error = "ログインが必要です";
      return;
    }
    // Keep the active feature section visible; hide the other panels so the
    // page reads as one surface. Chat stays visible (the feature specs use
    // the composer for setup) and its C22 behavior is the legacy one here.
    const hidden = new Set(hiddenSectionIds(route));
    for (const id of hidden) {
      const section = body.querySelector(`#${id}`);
      if (section instanceof HTMLElement) section.hidden = true;
    }
    const active = body.querySelector(`#${route.sectionId}`);
    if (active instanceof HTMLElement) active.hidden = false;
    while (body.firstChild !== null) {
      container.append(body.firstChild);
    }
    addStylesheet();
    addClient();
  } catch {
    error = "ページを読み込めませんでした";
  }
}

onMount(() => {
  void mountSurface();
  return () => {
    for (const node of injected) node.remove();
    injected = [];
  };
});
</script>

<svelte:head>
  <title>{route.title} · Companion Harness</title>
</svelte:head>

<header class="feature-nav">
  <a class="feature-brand" href="/">Companion Harness</a>
  <nav aria-label="機能">
    <a href="/" class:active={false}>チャット</a>
    {#each FEATURE_ROUTES as item (item.path)}
      <a href={item.path} class:active={item.path === route.path}
        >{item.label}</a
      >
    {/each}
  </nav>
</header>

{#if error.length > 0}
  <p class="feature-error" role="alert">{error}</p>
{/if}

<div class="feature-surface" bind:this={container}></div>
