// Navigation grouping: primary chat surfaces stay visible, operator tools
// live in the 開発・運用 disclosure. Routes themselves are unchanged.
import { describe, expect, test } from "vitest";
import {
  DEV_NAV,
  DEV_NAV_LABEL,
  FEATURE_ROUTES,
  PRIMARY_NAV,
  routeForPath,
} from "../src/lib/router.js";

describe("feature navigation grouping", () => {
  test("primary nav keeps the everyday surfaces in order", () => {
    expect(PRIMARY_NAV.map((item) => item.path)).toEqual([
      "/",
      "/memory",
      "/tasks",
      "/proposals",
      "/notifications",
      "/monitor",
    ]);
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual([
      "チャット",
      "記憶",
      "タスク・目的",
      "候補",
      "通知",
      "モニター",
    ]);
  });

  test("開発・運用 group holds the operator surfaces", () => {
    expect(DEV_NAV_LABEL).toBe("開発・運用");
    expect(DEV_NAV.map((item) => item.path)).toEqual([
      "/trials",
      "/shadow",
      "/learning",
      "/handoff",
    ]);
    expect(DEV_NAV.map((item) => item.label)).toEqual([
      "試行の提案",
      "試行",
      "学び",
      "引継ぎ",
    ]);
  });

  test("every feature route is grouped exactly once", () => {
    const grouped = [...PRIMARY_NAV, ...DEV_NAV].map((item) => item.path);
    expect(new Set(grouped).size).toBe(grouped.length);
    const featurePaths = FEATURE_ROUTES.map((route) => route.path).sort();
    const linkedFeaturePaths = grouped.filter((path) => path !== "/").sort();
    expect(linkedFeaturePaths).toEqual(featurePaths);
  });

  test("grouped paths still resolve to their unchanged routes", () => {
    for (const item of [...PRIMARY_NAV, ...DEV_NAV]) {
      if (item.path === "/") {
        expect(routeForPath("/")).toBeNull();
        continue;
      }
      expect(routeForPath(item.path)?.path).toBe(item.path);
    }
  });

  test("dev routes never leak into the primary nav", () => {
    const primaryPaths = new Set(PRIMARY_NAV.map((item) => item.path));
    for (const item of DEV_NAV) {
      expect(primaryPaths.has(item.path)).toBe(false);
    }
  });
});
