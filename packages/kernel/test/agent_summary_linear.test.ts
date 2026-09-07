// M2 review r3943538933: linear frozen-reference summary bounding.
// Each reference is formatted at most once; prefix lengths + exact marker
// accounting select the largest fitting deterministic prefix. No wall-clock
// assertions: the large-n case guards quadratic complexity via a join-count
// bound plus largest-prefix verification (a quadratic rebuild would need
// O(n) joins here).
import { MAX_MESSAGE_CONTENT_LENGTH } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { formatReferenceOmittedMarker, projectPrompt } from "../src/index.js";

function currentContent(req: ReturnType<typeof projectPrompt>): string {
  const last = req.messages[req.messages.length - 1] as { content: string };
  return last.content;
}

function makeRefs(count: number, pad = "x".repeat(40)) {
  return Array.from({ length: count }, (_, i) => ({
    ordinal: i + 1,
    title: `Title ${i + 1} ${pad}`,
  }));
}

describe("linear frozen-reference summary bounding", () => {
  it("bounds a large legal frozen context with few joins and the largest fitting prefix", () => {
    const references = makeRefs(20_000);
    const originalJoin = Array.prototype.join;
    let joinCalls = 0;
    Array.prototype.join = function (...args: unknown[]) {
      joinCalls += 1;
      // @ts-expect-error passthrough to the original join
      return originalJoin.apply(this, args);
    };
    try {
      const req = projectPrompt({
        requestText: "large legal frozen context",
        history: [],
        references,
        tools: [],
        model: "m",
      });
      const content = currentContent(req);
      expect(content.length).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_LENGTH);
      // Linear build: exactly one reference-lines join for the final
      // message. A quadratic shrink loop would join O(n) times.
      expect(joinCalls).toBeLessThanOrEqual(3);
      expect(content).toContain("large legal frozen context");
      expect(content).toContain("- r1:");
      const markerMatch = content.match(
        /\.\.\. and (\d+) more omitted to fit model message limit\./,
      );
      expect(markerMatch).not.toBeNull();
      const omitted = Number((markerMatch as RegExpMatchArray)[1]);
      expect(omitted).toBeGreaterThan(0);
      expect(content).toContain(formatReferenceOmittedMarker(omitted));
      const keptLines = content
        .split("\n")
        .filter((line) => line.startsWith("- r"));
      expect(keptLines.length + omitted).toBe(references.length);
      // Deterministic ordinal order: earliest prefix kept.
      expect(keptLines[0]).toBe(`- r1: Title 1 ${"x".repeat(40)}`);
      expect(keptLines[keptLines.length - 1]?.startsWith("- r")).toBe(true);
      const kept = keptLines.length;
      expect(content).not.toContain(`- r${references.length}:`);
      // Largest fitting prefix: kept fits, kept+1 (with its exact smaller
      // omitted marker) does not. Rebuild only these two candidates.
      const lines = references.map((ref) => `- r${ref.ordinal}: ${ref.title}`);
      const head = `User request:\nlarge legal frozen context\n`;
      const trailer =
        "Call ordinary tools for evidence when needed, then submit exactly one answer.submit call alone.";
      const header = "Session references (frozen structural summary):";
      const buildFor = (k: number): string => {
        const marker = formatReferenceOmittedMarker(references.length - k);
        const summary =
          k >= references.length
            ? `${header}\n${lines.join("\n")}`
            : `${header}\n${lines.slice(0, k).join("\n")}\n${marker}`;
        return `${head}${summary}\n${trailer}`;
      };
      expect(buildFor(kept).length).toBeLessThanOrEqual(
        MAX_MESSAGE_CONTENT_LENGTH,
      );
      expect(buildFor(kept).length).toBe(content.length);
      if (kept < references.length) {
        expect(buildFor(kept + 1).length).toBeGreaterThan(
          MAX_MESSAGE_CONTENT_LENGTH,
        );
      }
    } finally {
      Array.prototype.join = originalJoin;
    }
  });

  it("hits the exact fit boundary then omits exactly one line when one char over", () => {
    // Lines must exceed the omitted-marker cost so dropping one line saves
    // space (otherwise even kept=0 stays oversized and no prefix can fit).
    const pad = "p".repeat(80);
    const references = [
      { ordinal: 1, title: `A ${pad}` },
      { ordinal: 2, title: `B ${pad}` },
    ];
    const probe = projectPrompt({
      requestText: "",
      history: [],
      references,
      tools: [],
      model: "m",
    });
    const probeLength = currentContent(probe).length;
    const need = MAX_MESSAGE_CONTENT_LENGTH - probeLength;
    expect(need).toBeGreaterThan(1);
    const exactReq = projectPrompt({
      requestText: "u".repeat(need),
      history: [],
      references,
      tools: [],
      model: "m",
    });
    const exact = currentContent(exactReq);
    expect(exact.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    expect(exact).toContain(`- r1: A ${pad}`);
    expect(exact).toContain(`- r2: B ${pad}`);
    expect(exact).not.toContain("omitted to fit model message limit");

    const overReq = projectPrompt({
      requestText: "u".repeat(need + 1),
      history: [],
      references,
      tools: [],
      model: "m",
    });
    const over = currentContent(overReq);
    expect(over.length).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_LENGTH);
    expect(over).toContain("u".repeat(need + 1));
    expect(over).toContain(`- r1: A ${pad}`);
    expect(over).not.toContain("- r2:");
    expect(over).toContain(formatReferenceOmittedMarker(1));
  });

  it.each([9, 10, 99, 100])(
    "accounts exactly for the omitted-count marker width with %i omitted",
    (omittedTarget) => {
      // Uniform short lines keep marker-width effects isolated. Grow the
      // reference count until the bounded prefix leaves exactly the target
      // omitted count, tuning the request length.
      const total = omittedTarget + 3;
      // Titled rN-plus-title lines only (no canonical keys): uniform short
      // lines keep marker-width effects isolated.
      const references = Array.from({ length: total }, (_, i) => ({
        ordinal: i + 1,
        title: `t${i + 1}`,
      }));
      const lines = references.map((ref) => `- r${ref.ordinal}: ${ref.title}`);
      const trailer =
        "Call ordinary tools for evidence when needed, then submit exactly one answer.submit call alone.";
      const header = "Session references (frozen structural summary):";
      const keptWanted = total - omittedTarget;
      const marker = formatReferenceOmittedMarker(omittedTarget);
      const summaryWanted =
        keptWanted === 0
          ? `${header}\n${marker}`
          : `${header}\n${lines.slice(0, keptWanted).join("\n")}\n${marker}`;
      // Solve for the request length that makes keptWanted fit but
      // keptWanted+1 exceed, working backwards from the exact framing.
      const headPrefix = "User request:\n";
      const fixedFraming =
        headPrefix.length + 1 + summaryWanted.length + 1 + trailer.length;
      void fixedFraming;
      // Binary-search a request length producing exactly the wanted split.
      let requestText = "";
      let found = false;
      for (let len = 0; len <= MAX_MESSAGE_CONTENT_LENGTH; len += 1) {
        const candidate = projectPrompt({
          requestText: "q".repeat(len),
          history: [],
          references,
          tools: [],
          model: "m",
        });
        const content = currentContent(candidate);
        const keptLines = content
          .split("\n")
          .filter((line) => line.startsWith("- r"));
        if (
          content.length <= MAX_MESSAGE_CONTENT_LENGTH &&
          keptLines.length === keptWanted &&
          content.includes(marker)
        ) {
          // Confirm maximality: one more kept line must exceed.
          const nextMarker = formatReferenceOmittedMarker(omittedTarget - 1);
          const nextSummary =
            keptWanted + 1 >= total
              ? `${header}\n${lines.join("\n")}`
              : `${header}\n${lines.slice(0, keptWanted + 1).join("\n")}\n${nextMarker}`;
          const nextHead = `User request:\n${"q".repeat(len)}\n`;
          const nextLength =
            nextHead.length + nextSummary.length + 1 + trailer.length;
          if (
            keptWanted + 1 >= total ||
            nextLength > MAX_MESSAGE_CONTENT_LENGTH
          ) {
            requestText = "q".repeat(len);
            found = true;
            break;
          }
        }
        // Step coarsely once lengths are far from the boundary to keep this
        // linear-time test fast; fine steps only near the boundary.
        if (len % 512 === 0 && len > 0) {
          const probeContent = content;
          if (probeContent.length + 512 < MAX_MESSAGE_CONTENT_LENGTH - 2048) {
            len += 511;
          }
        }
      }
      expect(found).toBe(true);
      const req = projectPrompt({
        requestText,
        history: [],
        references,
        tools: [],
        model: "m",
      });
      const content = currentContent(req);
      expect(content).toContain(marker);
      const keptLines = content
        .split("\n")
        .filter((line) => line.startsWith("- r"));
      expect(keptLines.length + omittedTarget).toBe(total);
      expect(content.length).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_LENGTH);
    },
  );
});
