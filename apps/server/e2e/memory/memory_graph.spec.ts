// Real-browser conversation-memory graph E2E over the production UI/server.
//
// No API mocks: every flow drives the REAL graph controls (#memory-view-graph,
// #memory-graph-canvas, #memory-graph-global, #memory-graph-local,
// #memory-graph-depth, #memory-graph-retired, #memory-graph-status) against
// the REAL Hono app + real remind CLI temp DB (e2e/memory/server.ts).
//
// Fixture seeding is explicit test-only server code: the control endpoint
// resets the temp remind store and writes a 10-node/12-edge linked graph
// through the REAL CLI (`record.remember` with `links[]`). It also creates
// one owned Run for the browser session so the graph routes have their
// `runId` without a conversation turn (no synthetic extraction pollution).
//
// The last spec toggles a pass-through CLI wrapper that answers ONLY the
// graph ops with BAD_REQUEST, proving the "old remind" 503 status path.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { MEMORY_CONTROL_ORIGIN } from "./ports.js";

const GLOBAL_SCREENSHOT = "/tmp/memory-graph-global.png";
const HOVER_SCREENSHOT = "/tmp/memory-graph-hover.png";
const LOCAL_SCREENSHOT = "/tmp/memory-graph-local.png";

const SEED_NODE_COUNT = 10;
const SEED_EDGE_COUNT = 12;
/** Alpha's 1-hop neighbourhood in the seeded graph (alpha+3 neighbours). */
const LOCAL_NODE_COUNT = 4;
const LOCAL_EDGE_COUNT = 3;
const GLOBAL_AFTER_RETIRE_COUNT = 9;
const GLOBAL_AFTER_RETIRE_EDGES = 11;

async function controlPost(
  request: APIRequestContext,
  path: "/reset" | "/seed" | "/extraction" | "/legacy-graph",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${MEMORY_CONTROL_ORIGIN}${path}`, {
    data: body,
  });
  expect(res.ok(), `${path} ${res.status()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

function nodes(page: Page) {
  return page.locator("#memory-graph-canvas .memory-graph-node");
}

function edges(page: Page) {
  return page.locator("#memory-graph-canvas .memory-graph-edge");
}

/** Node group located by its unique label text (aria-label carries it too). */
function node(page: Page, label: string) {
  return nodes(page).filter({ hasText: label });
}

async function waitForGraphResponse(page: Page, suffix = "") {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(`/memory/graph${suffix}?`) &&
      response.status() === 200,
    { timeout: 30_000 },
  );
}

async function waitForDetailResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/searches/") &&
      response.url().includes("/items/") &&
      response.status() === 200,
    { timeout: 15_000 },
  );
}

async function settleLayout(page: Page): Promise<void> {
  // The deterministic layout decays alpha to zero (~2s at 60fps); a stable
  // screenshot needs the resting positions, not mid-simulation frames.
  await page.waitForTimeout(2_400);
}

/** Screenshot only the memory section (task-specified 1280x900 viewport). */
async function screenshotMemory(page: Page, path: string): Promise<void> {
  await page.locator("#memory").screenshot({ path });
}

/** Fraction of the canvas covered by the node-disc bounding box. */
async function graphFillRatio(
  page: Page,
): Promise<{ readonly width: number; readonly height: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector("#memory-graph-canvas");
    const dots = Array.from(
      document.querySelectorAll("#memory-graph-canvas .memory-graph-node__dot"),
    );
    if (!(canvas instanceof Element) || dots.length === 0) {
      return { width: 0, height: 0 };
    }
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return { width: 0, height: 0 };
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const dot of dots) {
      const rect = dot.getBoundingClientRect();
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.right);
      maxY = Math.max(maxY, rect.bottom);
    }
    return {
      width: (maxX - minX) / box.width,
      height: (maxY - minY) / box.height,
    };
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

test.beforeEach(async ({ page, request }) => {
  await page.goto("/memory");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#memory-view-graph")).toBeVisible();
  // Hermetic fixture: reset+seed the real remind DB, then create the owned
  // run through a REAL conversation turn with extraction suppressed (no
  // green-tea records pollute the seeded node/edge counts).
  await controlPost(request, "/extraction", { mode: "empty" });
  const seeded = await controlPost(request, "/seed", {});
  expect(seeded.nodes).toBe(SEED_NODE_COUNT);
  expect(seeded.edges).toBe(SEED_EDGE_COUNT);
  await send(page, "graph e2e turn");
  await expect(page.locator("#conversation")).toContainText(
    "Noted green tea.",
    { timeout: 30_000 },
  );
  await expect(page.locator("#composer-send")).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.locator("#memory-view-graph")).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  await controlPost(request, "/extraction", { mode: "default" });
});

test("graph view renders, highlights, opens detail, local depth 1, zooms, and refetches after retire", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  // 1. Global view: exact seeded node/edge counts (real Hono + real CLI).
  const initial = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/graph?") &&
      response.status() > 0,
    { timeout: 30_000 },
  );
  await page.locator("#memory-view-graph").click();
  const globalResponse = await initial;
  if (globalResponse.status() === 503) {
    const body = (await globalResponse.json()) as {
      error?: { code?: unknown };
    };
    if (body.error?.code === "memory_graph_unavailable") {
      // The CI-pinned remind revision predates graph ops. Keep the skip
      // explicit; bump the pin after remind#28 merges to run this suite.
      test.skip(
        true,
        "pinned remind build has no graph ops (bump after remind#28)",
      );
      return;
    }
  }
  expect(globalResponse.status()).toBe(200);
  const globalBody = (await globalResponse.json()) as {
    scope?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  expect(globalBody.scope).toBe("global");
  expect(globalBody.nodes).toHaveLength(SEED_NODE_COUNT);
  expect(globalBody.edges).toHaveLength(SEED_EDGE_COUNT);
  await expect(nodes(page)).toHaveCount(SEED_NODE_COUNT);
  await expect(edges(page)).toHaveCount(SEED_EDGE_COUNT);
  await settleLayout(page);
  // Fit-to-view: the discs fill ~85% of the limiting canvas dimension.
  const fill = await graphFillRatio(page);
  expect(Math.max(fill.width, fill.height)).toBeGreaterThan(0.7);
  expect(Math.max(fill.width, fill.height)).toBeLessThan(0.95);
  // <= 80 nodes -> every label is visible without hovering.
  const visibleLabels = await page
    .locator("#memory-graph-canvas .memory-graph-node__label")
    .evaluateAll(
      (elements) =>
        elements.filter(
          (element) => getComputedStyle(element).display !== "none",
        ).length,
    );
  expect(visibleLabels).toBe(SEED_NODE_COUNT);
  for (const legend of ["事実", "推論", "要約", "訂正", "引退"]) {
    await expect(page.locator("#memory-graph-legend")).toContainText(legend);
  }
  await screenshotMemory(page, GLOBAL_SCREENSHOT);

  // 1b. List -> graph must restore the loaded graph, not an empty canvas:
  // the list view unmounts the SVG/GraphCanvas, so the panel rehydrates the
  // retained payload when the canvas remounts (no manual refresh needed).
  await page.locator("#memory-view-list").click();
  await expect(page.locator("#memory-search-form")).toBeVisible();
  await page.locator("#memory-view-graph").click();
  await expect(nodes(page)).toHaveCount(SEED_NODE_COUNT);
  await expect(edges(page)).toHaveCount(SEED_EDGE_COUNT);
  await settleLayout(page);

  // 2. Search highlights matching node(s) via the CSS class (no API call).
  await page.locator("#memory-search-input").fill("alpha");
  await expect(node(page, "alpha")).toHaveClass(/memory-graph-node--match/);
  await expect(node(page, "bravo")).not.toHaveClass(/memory-graph-node--match/);

  // 3. Hover dims non-neighbours and keeps the 1-hop neighbourhood visible.
  await page.locator("#memory-search-input").fill("");
  await node(page, "alpha").locator(".memory-graph-node__dot").hover();
  await expect(node(page, "alpha")).toHaveClass(/memory-graph-node--label/);
  for (const neighbour of ["bravo", "charlie", "delta"]) {
    await expect(node(page, neighbour)).toHaveClass(/memory-graph-node--label/);
  }
  await expect(node(page, "bravo")).not.toHaveClass(/memory-graph-node--dim/);
  await expect(node(page, "charlie")).not.toHaveClass(/memory-graph-node--dim/);
  await expect(node(page, "delta")).not.toHaveClass(/memory-graph-node--dim/);
  await expect(node(page, "echo")).toHaveClass(/memory-graph-node--dim/);
  await expect(node(page, "echo")).not.toHaveClass(/memory-graph-node--label/);
  // No background rectangles at all (the old faint hover artifacts) and the
  // dimmed label loses its paint halo.
  await expect(page.locator("#memory-graph-canvas rect")).toHaveCount(0);
  await expect(
    node(page, "echo").locator(".memory-graph-node__label"),
  ).toHaveCSS("stroke", "none");
  await screenshotMemory(page, HOVER_SCREENSHOT);

  // 4. Click opens the existing bound detail drawer with the node body.
  const detail = waitForDetailResponse(page);
  await node(page, "alpha").locator(".memory-graph-node__dot").click();
  expect((await detail).status()).toBe(200);
  await expect(page.locator("#memory-detail")).toBeVisible();
  await expect(page.locator("#memory-detail-body")).toContainText(
    "graph seed alpha",
  );

  // 5. Local depth 1: the selected centre plus exactly its neighbours.
  await page.locator("#memory-graph-depth").selectOption("1");
  const localPromise = waitForGraphResponse(page, "/local");
  await page.locator("#memory-graph-local").click();
  const localResponse = await localPromise;
  const localBody = (await localResponse.json()) as {
    scope?: unknown;
    center?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  expect(localBody.scope).toBe("local");
  expect(localBody.nodes).toHaveLength(LOCAL_NODE_COUNT);
  expect(localBody.edges).toHaveLength(LOCAL_EDGE_COUNT);
  await expect(nodes(page)).toHaveCount(LOCAL_NODE_COUNT);
  await expect(edges(page)).toHaveCount(LOCAL_EDGE_COUNT);
  for (const label of ["alpha", "bravo", "charlie", "delta"]) {
    await expect(node(page, label)).toHaveCount(1);
  }
  await expect(node(page, "echo")).toHaveCount(0);
  await settleLayout(page);
  await screenshotMemory(page, LOCAL_SCREENSHOT);

  // 6. Wheel zoom changes the SVG viewport transform (cursor-anchored).
  const viewport = page.locator("#memory-graph-canvas .memory-graph-viewport");
  const transformBefore = await viewport.getAttribute("transform");
  const canvas = page.locator("#memory-graph-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
  }
  await expect
    .poll(async () => viewport.getAttribute("transform"), { timeout: 5_000 })
    .not.toBe(transformBefore);

  // 7. Back to global, retire a node, then prove the post-ack refetch.
  const backToGlobal = waitForGraphResponse(page);
  await page.locator("#memory-graph-global").click();
  expect((await backToGlobal).status()).toBe(200);
  await expect(nodes(page)).toHaveCount(SEED_NODE_COUNT);
  const julietDetail = waitForDetailResponse(page);
  await node(page, "juliet").locator(".memory-graph-node__dot").click();
  expect((await julietDetail).status()).toBe(200);
  await expect(page.locator("#memory-detail")).toBeVisible();

  const refetch = waitForGraphResponse(page);
  const mutation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/memory/mutations"),
    { timeout: 15_000 },
  );
  await page.locator("#memory-retire-button").click();
  expect((await mutation).status()).toBe(202);
  await expect(page.locator("#memory-op-status")).toContainText("acked", {
    timeout: 45_000,
  });
  expect((await refetch).status()).toBe(200);
  // Default (引退も表示 off): the retired node and its edge disappear.
  await expect(nodes(page)).toHaveCount(GLOBAL_AFTER_RETIRE_COUNT);
  await expect(edges(page)).toHaveCount(GLOBAL_AFTER_RETIRE_EDGES);
  await expect(node(page, "juliet")).toHaveCount(0);

  // 8. 引退も表示: the same node comes back with the retired style class.
  const retiredRefetch = waitForGraphResponse(page);
  await page.locator("#memory-graph-retired").check();
  expect((await retiredRefetch).status()).toBe(200);
  await expect(nodes(page)).toHaveCount(SEED_NODE_COUNT);
  await expect(node(page, "juliet")).toHaveClass(/memory-graph-node--retired/);
});

test("old remind without graph ops shows the fixed unavailable status", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await controlPost(request, "/legacy-graph", { enabled: true });
  try {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/memory/graph?"),
      { timeout: 30_000 },
    );
    await page.locator("#memory-view-graph").click();
    const response = await responsePromise;
    expect(response.status()).toBe(503);
    const body = (await response.json()) as {
      error?: { code?: unknown };
    };
    expect(body.error?.code).toBe("memory_graph_unavailable");
    await expect(page.locator("#memory-graph-status")).toContainText(
      "グラフ機能は記憶サーバーの更新後に利用できます",
    );
    // The list view stays usable after a graph-unavailable response.
    await page.locator("#memory-view-list").click();
    await expect(page.locator("#memory-search-form")).toBeVisible();
  } finally {
    await controlPost(request, "/legacy-graph", { enabled: false });
  }
});
