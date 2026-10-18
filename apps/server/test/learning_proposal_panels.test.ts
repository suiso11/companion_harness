// AV04 Codex #47 review regressions (UI panel half).
//
// Exercises the REAL LearningPanel + ProposalPanel browser modules against
// a stub DOM + stub HTTP layer (no jsdom, no network):
// - learning refresh re-fetches a selected hypothesis absent from the NEWLY
//   RETURNED page (not the merged cache), so older-page selections cannot
//   go stale;
// - the learning list keeps the paged API's append order for equal
//   timestamps (no UUID tie-breaker);
// - concurrent evidence-page loads never duplicate rows (gate + merge by id);
// - refreshing an open learning detail reloads the first evidence page
//   while preserving typed inputs;
// - every evidence row offers a one-tap source reuse into the attach form
//   (no undiscoverable UUID memorization);
// - proposal accept/reject applies the mutation response to the cache, so
//   an old decided draft outside the newest history page stops rendering
//   as pending.

import { describe, expect, it } from "vitest";
import { LearningPanel } from "../src/ui/learning_panel.js";
import { ProposalPanel } from "../src/ui/proposal_panel.js";

interface StubRes {
  status: number;
  body: unknown;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(readonly tag: string) {}

  get firstChild(): FakeElement | null {
    return this.children.length > 0 ? (this.children[0] ?? null) : null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.children.push(node);
  }

  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }

  removeChild(node: FakeElement): FakeElement {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    return node;
  }

  addEventListener(type: string, listener: () => void): void {
    const known = this.listeners.get(type) ?? [];
    known.push(listener);
    this.listeners.set(type, known);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  scrollIntoView(): void {}
}

class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();

  getElementById(id: string): FakeElement {
    let el = this.byId.get(id);
    if (el === undefined) {
      el = new FakeElement("div");
      this.byId.set(id, el);
    }
    return el;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(): void {}
}

class StubHttp {
  getCalls: string[] = [];
  onGet: (path: string) => StubRes = () => ({ status: 404, body: {} });
  onPost: (path: string, _payload: unknown, _key: string) => StubRes = () => ({
    status: 500,
    body: {},
  });

  async get(path: string): Promise<StubRes> {
    this.getCalls.push(path);
    return this.onGet(path);
  }

  async post(path: string, payload: unknown, key: string): Promise<StubRes> {
    return this.onPost(path, payload, key);
  }
}

function installDocument(): FakeDocument {
  const doc = new FakeDocument();
  (globalThis as unknown as Record<string, unknown>).document = doc;
  return doc;
}

async function flush(rounds = 8): Promise<void> {
  for (let n = 0; n < rounds; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function hypothesisView(overrides: Record<string, unknown>): unknown {
  return {
    id: "h-x",
    sessionId: "S1",
    scope: "health",
    kind: "method",
    statement: "statement",
    status: "open",
    version: 1,
    origin: "human",
    staged: false,
    needsReevaluation: false,
    evidenceCounts: { supports: 0, refutes: 0, neutral: 0 },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function evidenceView(overrides: Record<string, unknown>): unknown {
  return {
    id: "e-x",
    hypothesisId: "h-1",
    sessionId: "S1",
    polarity: "supports",
    sourceKind: "shadow_job",
    sourceId: "11111111-1111-4111-8111-111111111111",
    note: null,
    createdAt: 10,
    ...overrides,
  };
}

function listButtons(doc: FakeDocument, listId: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const li of doc.getElementById(listId).children) {
    for (const child of li.children) out.push(child);
  }
  return out;
}

describe("learning panel codex47 regressions", () => {
  it("refresh re-fetches a selected row absent from the fresh page", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const oldRow = hypothesisView({ id: "old-1", version: 1, updatedAt: 1000 });
    let listPage: unknown[] = [oldRow];
    let singleBody: unknown = oldRow;
    http.onGet = (path) => {
      if (path.includes("/evidence")) {
        return {
          status: 200,
          body: { items: [], nextCursor: null, hasMore: false },
        };
      }
      if (path.endsWith("/learning/hypotheses?limit=50")) {
        return {
          status: 200,
          body: { items: listPage, nextCursor: null, hasMore: false },
        };
      }
      return { status: 200, body: singleBody };
    };
    const panel = new LearningPanel({
      getSessionId: () => "S1",
      http,
      randomKey: () => "k-1",
    });
    panel.bind();
    doc.getElementById("learning-refresh").click();
    await flush();
    listButtons(doc, "learning-list")[0]?.click();
    await flush();

    // The selection came from an older page: it is cached, yet the newest
    // page no longer carries it and the record changed externally.
    listPage = [
      hypothesisView({
        id: "new-9",
        version: 1,
        createdAt: 5000,
        updatedAt: 5000,
      }),
    ];
    singleBody = hypothesisView({ id: "old-1", version: 2, updatedAt: 9000 });
    const before = http.getCalls.length;
    doc.getElementById("learning-refresh").click();
    await flush();

    const freshCalls = http.getCalls.slice(before);
    expect(
      freshCalls.some((path) => path.endsWith("/learning/hypotheses/old-1")),
    ).toBe(true);
    const texts = doc
      .getElementById("learning-detail-body")
      .children.map((node) => node.textContent);
    expect(texts.some((text) => text.includes("版 2"))).toBe(true);
  });

  it("keeps server append order for equal timestamps", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const first = hypothesisView({
      id: "id-b",
      scope: "alpha-first",
      createdAt: 1000,
    });
    const second = hypothesisView({
      id: "id-a",
      scope: "beta-second",
      createdAt: 1000,
    });
    http.onGet = () => ({
      status: 200,
      body: { items: [first, second], nextCursor: null, hasMore: false },
    });
    const panel = new LearningPanel({
      getSessionId: () => "S1",
      http,
      randomKey: () => "k-1",
    });
    panel.bind();
    doc.getElementById("learning-refresh").click();
    await flush();
    const buttons = listButtons(doc, "learning-list");
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toContain("alpha-first");
    expect(buttons[1]?.textContent).toContain("beta-second");
  });

  it("concurrent evidence-page loads never duplicate rows", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const row = hypothesisView({ id: "h-1" });
    const item = evidenceView({ id: "e-1" });
    http.onGet = (path) => {
      if (path.includes("/evidence")) {
        if (path.includes("cursor=")) {
          return {
            status: 200,
            body: { items: [item], nextCursor: null, hasMore: false },
          };
        }
        return {
          status: 200,
          body: { items: [item], nextCursor: "c1", hasMore: true },
        };
      }
      return {
        status: 200,
        body: { items: [row], nextCursor: null, hasMore: false },
      };
    };
    const panel = new LearningPanel({
      getSessionId: () => "S1",
      http,
      randomKey: () => "k-1",
    });
    panel.bind();
    doc.getElementById("learning-refresh").click();
    await flush();
    listButtons(doc, "learning-list")[0]?.click();
    await flush();
    // Double-click the evidence pager before either reply lands.
    doc.getElementById("learning-evidence-more").click();
    doc.getElementById("learning-evidence-more").click();
    await flush();
    expect(doc.getElementById("learning-evidence-list").children.length).toBe(
      1,
    );
  });

  it("refresh reloads evidence for the open detail and keeps typed inputs", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const row = hypothesisView({ id: "h-1" });
    let evidenceItems: unknown[] = [];
    http.onGet = (path) => {
      if (path.includes("/evidence")) {
        return {
          status: 200,
          body: { items: evidenceItems, nextCursor: null, hasMore: false },
        };
      }
      return {
        status: 200,
        body: { items: [row], nextCursor: null, hasMore: false },
      };
    };
    const panel = new LearningPanel({
      getSessionId: () => "S1",
      http,
      randomKey: () => "k-1",
    });
    panel.bind();
    doc.getElementById("learning-refresh").click();
    await flush();
    listButtons(doc, "learning-list")[0]?.click();
    await flush();
    expect(
      doc.getElementById("learning-evidence-list").children[0]?.textContent,
    ).toContain("まだありません");

    // Another tab attaches evidence; the human also typed a note draft.
    evidenceItems = [evidenceView({ id: "e-9" })];
    doc.getElementById("learning-evidence-note").value = "draft note";
    doc.getElementById("learning-refresh").click();
    await flush();
    const rows = doc.getElementById("learning-evidence-list").children;
    expect(rows.length).toBe(1);
    expect(rows[0]?.children[0]?.textContent).toContain("支持");
    expect(doc.getElementById("learning-evidence-note").value).toBe(
      "draft note",
    );
  });

  it("evidence rows offer one-tap source reuse into the attach form", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const row = hypothesisView({ id: "h-1" });
    const item = evidenceView({
      id: "e-9",
      sourceKind: "task_event",
      sourceId: "22222222-2222-4222-8222-222222222222",
    });
    http.onGet = (path) => {
      if (path.includes("/evidence")) {
        return {
          status: 200,
          body: { items: [item], nextCursor: null, hasMore: false },
        };
      }
      return {
        status: 200,
        body: { items: [row], nextCursor: null, hasMore: false },
      };
    };
    const panel = new LearningPanel({
      getSessionId: () => "S1",
      http,
      randomKey: () => "k-1",
    });
    panel.bind();
    doc.getElementById("learning-refresh").click();
    await flush();
    listButtons(doc, "learning-list")[0]?.click();
    await flush();
    const evidenceRows = doc.getElementById("learning-evidence-list").children;
    expect(evidenceRows.length).toBe(1);
    const actions = evidenceRows[0]?.children ?? [];
    // Label + read-only "open source" + reuse affordance (never a raw UUID wall).
    expect(actions.length).toBe(3);
    actions[2]?.click();
    expect(doc.getElementById("learning-evidence-source-id").value).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(doc.getElementById("learning-evidence-source-kind").value).toBe(
      "task_event",
    );
  });
});

describe("proposal panel codex47 regressions", () => {
  it("accept applies the mutation response so the old draft leaves pending", async () => {
    const doc = installDocument();
    const http = new StubHttp();
    const base = {
      id: "p-1",
      sessionId: "S1",
      scope: "health",
      target: "task",
      draftKind: "wish",
      purposeKind: null,
      taskKind: "task",
      sourceQuote: "quote",
      interpretation: "interp",
      sourceKind: "model",
      sourceTurnId: "turn-1",
      sourceRunId: "run-1",
      parentPurposeId: null,
      expectedParentVersion: null,
      version: 1,
      acceptedTargetId: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    let pendingPage: unknown[] = [{ ...base, status: "pending" }];
    const historyPage: unknown[] = [];
    http.onGet = (path) => {
      if (path.includes("status=pending")) {
        return {
          status: 200,
          body: {
            items: pendingPage,
            nextCursor: null,
            hasMore: false,
            pendingCount: pendingPage.length,
          },
        };
      }
      return {
        status: 200,
        body: {
          items: historyPage,
          nextCursor: null,
          hasMore: false,
          pendingCount: 0,
        },
      };
    };
    http.onPost = (path) => {
      expect(path).toContain("/conversation-proposals/p-1/accept");
      return {
        status: 201,
        body: {
          ...base,
          status: "accepted",
          version: 2,
          acceptedTargetId: "t-1",
        },
      };
    };
    const panel = new ProposalPanel({
      getSessionId: () => "S1",
      isNaturalBreak: () => false,
      http,
      randomKey: () => "k-9",
    });
    panel.bind();
    doc.getElementById("proposal-refresh").click();
    await flush();
    listButtons(doc, "proposal-list")[0]?.click();
    await flush();

    // Accepting retires the pending queue entry while its old creation
    // position sits outside the newest history page.
    pendingPage = [];
    doc.getElementById("proposal-accept").click();
    await flush();
    await flush();
    const buttons = listButtons(doc, "proposal-list");
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toContain("採用済み");
    expect(buttons[0]?.textContent).not.toContain("未採用");
  });
});
