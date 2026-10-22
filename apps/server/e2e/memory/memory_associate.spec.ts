// Real-browser conversation-memory ASSOCIATION E2E over the production UI.
//
// Fixture shape (all through the REAL remind CLI, no API mocks):
//   - five records seeded WITHOUT explicit links/tags;
//   - `topic.set` assigns バイク to the four motorcycle memories and 料理 to
//     the miso memory;
//   - ONE `maintain.associate` pass derives `similar_edges` (vectors enabled
//     only for this fixture config copy, because cosine similarity needs
//     embeddings; the topic bonus lifts same-topic pairs over minScore).
//
// The spec then drives the production list/graph UI: browse list shows all
// five without a search, search + 「すべて表示」 still work, the graph shows
// the derived similar edges between bike memories, and 「話題を表示」 adds a
// バイク hub whose click highlights its four member nodes.
//
// Like the existing graph specs, a remind build without the required ops
// (or without the pinned vector model) SKIPS with an explicit reason rather
// than failing the suite.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { MEMORY_CONTROL_ORIGIN } from "./ports.js";

const LIST_SCREENSHOT = "/tmp/memory-assoc-list.png";
const GRAPH_SCREENSHOT = "/tmp/memory-assoc-graph.png";
const HUB_SCREENSHOT = "/tmp/memory-assoc-hub.png";

/** Exact fixture bodies: four motorcycle memories + one cooking memory. */
const BIKE_LABELS = [
  "Ninja H2のスーパーチャージャーの吸気音が好き",
  "GSX-S1000Fに乗りたい",
  "ZX-4R SEも候補",
  "バイクはスピード重視で選ぶ",
] as const;
const MISO_LABEL = "味噌汁は赤味噌が好き";
const ALL_LABELS = [...BIKE_LABELS, MISO_LABEL] as const;
/** Two topic hubs: バイク (4 members) + 料理 (1 member). */
const TOPIC_HUB_COUNT = 2;
const BIKE_HUB_EDGES = 4;
const MISO_HUB_EDGES = 1;

interface AssociationSeed {
  readonly supported?: unknown;
  readonly reason?: unknown;
  readonly stage?: unknown;
  readonly labels?: unknown;
  readonly vectorModelPresent?: unknown;
  readonly associate?: {
    readonly degraded?: unknown;
    readonly edgesWritten?: unknown;
    readonly remaining?: unknown;
  } | null;
}

interface GraphNodeBody {
  readonly handle?: unknown;
  readonly label?: unknown;
}

interface GraphEdgeBody {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly kind?: unknown;
}

interface GraphBody {
  readonly nodes?: unknown;
  readonly edges?: unknown;
}

function graphNodes(page: Page) {
  return page.locator("#memory-graph-canvas .memory-graph-node");
}

function graphEdges(page: Page) {
  return page.locator("#memory-graph-canvas .memory-graph-edge");
}

function nodeByHandle(page: Page, handle: string) {
  return page.locator(
    `#memory-graph-canvas .memory-graph-node[data-handle="${handle}"]`,
  );
}

function waitForBrowse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/graph?") &&
      response.status() === 200,
    { timeout: 30_000 },
  );
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function controlPost(
  request: APIRequestContext,
  path: "/seed-association" | "/extraction",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${MEMORY_CONTROL_ORIGIN}${path}`, {
    data: body,
  });
  expect(res.ok(), `${path} ${res.status()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function debugGraphBox(page: Page): Promise<void> {
  const info = await page.evaluate(() => {
    const canvas = document.querySelector("#memory-graph-canvas");
    const viewport = document.querySelector(
      "#memory-graph-canvas .memory-graph-viewport",
    );
    if (!(canvas instanceof Element)) {
      return null;
    }
    const box = canvas.getBoundingClientRect();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const dots = Array.from(
      document.querySelectorAll("#memory-graph-canvas .memory-graph-node__dot"),
    );
    for (const dot of dots) {
      const rect = dot.getBoundingClientRect();
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.right);
      maxY = Math.max(maxY, rect.bottom);
    }
    return {
      box: {
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
      },
      viewBox: canvas.getAttribute("viewBox"),
      transform: viewport?.getAttribute("transform") ?? null,
      dots: {
        width: maxX - minX,
        height: maxY - minY,
        centerX: (minX + maxX) / 2 - box.left,
        centerY: (minY + maxY) / 2 - box.top,
        ratioWidth: (maxX - minX) / box.width,
        ratioHeight: (maxY - minY) / box.height,
      },
    };
  });
  console.log("DEBUG GRAPH BOX", JSON.stringify(info));
}

async function settleLayout(page: Page): Promise<void> {
  // The deterministic layout decays alpha to zero (~2s at 60fps); a stable
  // screenshot needs the resting positions, not mid-simulation frames.
  await page.waitForTimeout(2_400);
}

async function screenshotMemory(page: Page, path: string): Promise<void> {
  // Opt-in only: CI runs stay screenshot-free unless explicitly requested.
  if (process.env.MEMORY_SCREENSHOTS !== "1") {
    return;
  }
  await page.locator("#memory").screenshot({ path });
}

test.beforeEach(async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/memory");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#memory-view-list")).toBeVisible();
  // Extraction suppressed: the conversation still creates the owned run,
  // but adds no green-tea records to the five-record association fixture.
  await controlPost(request, "/extraction", { mode: "empty" });
  const seed = (await controlPost(request, "/seed-association", {
    scope: "personal/default",
  })) as AssociationSeed;

  if (seed.supported !== true) {
    test.skip(
      true,
      `pinned remind build lacks association ops (${String(
        seed.reason ?? seed.stage ?? "topic.set/maintain.associate",
      )})`,
    );
  }
  if (seed.vectorModelPresent !== true) {
    test.skip(
      true,
      "pinned embedding model missing (set COMPANION_MEMORY_TEST_VECTORS_MODEL_DIR)",
    );
  }
  if (seed.associate?.degraded === true) {
    test.skip(true, "maintain.associate reported degraded (no embeddings)");
  }

  await send(page, "association e2e turn");
  await expect(page.locator("#conversation")).toContainText(
    "Noted green tea.",
    {
      timeout: 30_000,
    },
  );
  await expect(page.locator("#composer-send")).toBeEnabled({
    timeout: 30_000,
  });

  // Refresh the default browse list AFTER seeding (the boot load happened
  // before the fixture existed). This is the plain 一覧 view, no search.
  const browse = waitForBrowse(page);
  await page.locator("#memory-view-list").click();
  expect((await browse).status()).toBe(200);
  await expect(page.locator("#memory-list li")).toHaveCount(ALL_LABELS.length, {
    timeout: 15_000,
  });
});

test.afterEach(async ({ request }) => {
  await controlPost(request, "/extraction", { mode: "default" });
});

test("list browses all memories, search/すべて表示 round-trips, graph shows similar edges and a clickable バイク topic hub", async ({
  page,
}) => {
  test.setTimeout(240_000);

  // 1. Browse list: all five memories in the scroll container, no search.
  const scroll = page.locator("#memory .memory-list-scroll");
  await expect(scroll).toBeVisible();
  await expect(scroll).toHaveCSS("overflow-y", "auto");
  for (const label of ALL_LABELS) {
    await expect(
      page.locator("#memory-list li").filter({ hasText: label }),
    ).toHaveCount(1);
  }
  // One derived topic chip per record (four バイク + one 料理).
  await expect(page.locator("#memory-list .memory-topic-chip")).toHaveCount(
    ALL_LABELS.length,
  );
  await screenshotMemory(page, LIST_SCREENSHOT);

  // 2. Explicit search still works, then 「すべて表示」 restores the browse.
  const searchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/memory/search") &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await page.locator("#memory-search-input").fill("GSX-S1000F");
  await page.locator("#memory-search-button").click();
  const search = await searchResponse;
  const searchBody = (await search.json()) as {
    hits?: Array<{ snippet?: unknown }>;
  };
  expect(
    (searchBody.hits ?? []).some((hit) =>
      String(hit.snippet ?? "").includes("GSX-S1000F"),
    ),
  ).toBe(true);
  await expect(
    page.locator("#memory-list li").filter({ hasText: "GSX-S1000F" }),
  ).toHaveCount(1);
  await expect(page.locator("#memory-list-all")).toBeVisible();

  const restored = waitForBrowse(page);
  await page.locator("#memory-list-all").click();
  expect((await restored).status()).toBe(200);
  await expect(page.locator("#memory-list li")).toHaveCount(ALL_LABELS.length);
  await expect(page.locator("#memory-list-all")).toBeHidden();
  // Clear the highlighter before the graph view (the same input filters
  // labels there).
  await page.locator("#memory-search-input").fill("");

  // 3. Graph view: five memories + two topic hubs, with derived similar
  //    edges that only connect motorcycle memories (miso stays separate).
  const graphResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/graph?") &&
      response.status() > 0,
    { timeout: 30_000 },
  );
  await page.locator("#memory-view-graph").click();
  const graphResponse = await graphResponsePromise;
  if (graphResponse.status() === 503) {
    const body = (await graphResponse.json()) as {
      error?: { code?: unknown };
    };
    if (body.error?.code === "memory_graph_unavailable") {
      test.skip(
        true,
        "pinned remind build has no graph ops (bump after remind#28)",
      );
      return;
    }
  }
  expect(graphResponse.status()).toBe(200);
  const graph = (await graphResponse.json()) as GraphBody;
  const rawNodes = (graph.nodes ?? []) as GraphNodeBody[];
  const rawEdges = (graph.edges ?? []) as GraphEdgeBody[];
  expect(rawNodes).toHaveLength(ALL_LABELS.length);
  const handleByLabel = new Map<string, string>();
  for (const raw of rawNodes) {
    if (typeof raw.handle === "string" && typeof raw.label === "string") {
      handleByLabel.set(raw.label, raw.handle);
    }
  }
  const handleFor = (label: string): string => {
    const handle = handleByLabel.get(label);
    expect(handle, `graph node handle for ${label}`).toBeDefined();
    return handle as string;
  };
  const bikeHandles = BIKE_LABELS.map(handleFor);
  const misoHandle = handleFor(MISO_LABEL);
  const similarEdges = rawEdges.filter((edge) => edge.kind === "similar");
  expect(similarEdges.length).toBeGreaterThan(0);
  const bikeHandleSet = new Set(bikeHandles);
  for (const edge of similarEdges) {
    expect(bikeHandleSet.has(String(edge.from))).toBe(true);
    expect(bikeHandleSet.has(String(edge.to))).toBe(true);
  }
  // No similar edge may touch the unrelated miso memory.
  expect(
    similarEdges.some(
      (edge) => edge.from === misoHandle || edge.to === misoHandle,
    ),
  ).toBe(false);

  // 「話題を表示」 is on by default: hubs render client-side.
  await expect(page.locator("#memory-graph-topics")).toBeChecked();
  await expect(graphNodes(page)).toHaveCount(
    ALL_LABELS.length + TOPIC_HUB_COUNT,
  );
  await expect(
    page.locator("#memory-graph-canvas .memory-graph-node--topic"),
  ).toHaveCount(TOPIC_HUB_COUNT);
  await expect(
    page
      .locator("#memory-graph-canvas .memory-graph-node--topic")
      .filter({ hasText: "バイク" }),
  ).toHaveCount(1);
  await expect(
    page
      .locator("#memory-graph-canvas .memory-graph-node--topic")
      .filter({ hasText: "料理" }),
  ).toHaveCount(1);
  await expect(
    page.locator("#memory-graph-canvas .memory-graph-edge--similar"),
  ).toHaveCount(similarEdges.length);
  await expect(graphEdges(page)).toHaveCount(
    similarEdges.length + BIKE_HUB_EDGES + MISO_HUB_EDGES,
  );
  await settleLayout(page);
  await debugGraphBox(page);
  await screenshotMemory(page, GRAPH_SCREENSHOT);

  // 4. Clicking the バイク hub highlights its four members (1-hop focus) and
  //    dims the unrelated memory; a hub never opens the detail drawer.
  const bikeHub = page
    .locator("#memory-graph-canvas .memory-graph-node--topic")
    .filter({ hasText: "バイク" });
  await bikeHub.locator(".memory-graph-node__dot").click();
  await expect(bikeHub).toHaveClass(/memory-graph-node--selected/);
  for (const handle of bikeHandles) {
    await expect(nodeByHandle(page, handle)).not.toHaveClass(
      /memory-graph-node--dim/,
    );
  }
  await expect(nodeByHandle(page, misoHandle)).toHaveClass(
    /memory-graph-node--dim/,
  );
  await expect(page.locator("#memory-detail")).toBeHidden();
  await page.waitForTimeout(150);
  await screenshotMemory(page, HUB_SCREENSHOT);
});
