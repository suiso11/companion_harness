// Unit pin for the ops notice heading/label mapping: an urgent SYSTEM
// (kind="ops") notice must render 要確認（ops） everywhere the kind label
// is computed (urgent head AND the priority segment of the source line
// that also appears in history/detail), never the receipt label
// 要確認（受領）. Live bug: the priority map labelled every urgent notice
// 要確認（受領） even for system ops failures.

import { describe, expect, it } from "vitest";
import { priorityLabel } from "../src/ui/notification_panel.js";

describe("notification priority label (kind-aware)", () => {
  it("labels urgent ops notices 要確認（ops）", () => {
    expect(priorityLabel({ kind: "ops", priority: "urgent" })).toBe(
      "要確認（ops）",
    );
  });

  it("labels urgent receipt notices 要確認（受領）", () => {
    expect(priorityLabel({ kind: "commitment", priority: "urgent" })).toBe(
      "要確認（受領）",
    );
    expect(priorityLabel({ kind: "question", priority: "urgent" })).toBe(
      "要確認（受領）",
    );
  });

  it("labels routine notices 通常 regardless of kind", () => {
    expect(priorityLabel({ kind: "ops", priority: "routine" })).toBe("通常");
    expect(priorityLabel({ kind: "progress", priority: "routine" })).toBe(
      "通常",
    );
  });

  it("falls back to お知らせ for an unknown priority", () => {
    expect(priorityLabel({ kind: "ops", priority: "mystery" })).toBe(
      "お知らせ",
    );
  });
});
