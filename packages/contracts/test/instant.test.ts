import { describe, expect, it } from "vitest";
import { isStrictCalendarInstant, parseStrictCalendarInstantMs } from "../src/instant.js";

/**
 * Shared strict instant contract (B2/C10-08): one grammar for every
 * inbound instant path. Boundary rule set per entry point is identical —
 * whole seconds and millisecond-expressible fractions accept, genuine
 * sub-millisecond precision rejects (never a silent truncate).
 */
describe("parseStrictCalendarInstantMs / isStrictCalendarInstant", () => {
  const cases: Array<[string, number | undefined]> = [
    // Whole seconds, both offset forms.
    ["2026-03-01T10:00:00Z", Date.UTC(2026, 2, 1, 10, 0, 0)],
    ["2026-03-01T10:00:00+05:30", Date.UTC(2026, 2, 1, 4, 30, 0)],
    ["2026-03-01T10:00:00-08:00", Date.UTC(2026, 2, 1, 18, 0, 0)],
    // Millisecond-expressible fractions (trailing-zero rule).
    ["2026-03-01T10:00:00.123Z", Date.UTC(2026, 2, 1, 10, 0, 0, 123)],
    ["2026-03-01T10:00:00.12Z", Date.UTC(2026, 2, 1, 10, 0, 0, 120)],
    ["2026-03-01T10:00:00.123000Z", Date.UTC(2026, 2, 1, 10, 0, 0, 123)],
    ["2026-03-01T10:00:00.120000Z", Date.UTC(2026, 2, 1, 10, 0, 0, 120)],
    ["2026-03-01T10:00:00.1+00:30", Date.UTC(2026, 2, 1, 9, 30, 0, 100)],
    // Genuine sub-millisecond precision is rejected (never truncated).
    ["2026-03-01T10:00:00.1234Z", undefined],
    ["2026-03-01T10:00:00.1230001Z", undefined],
    ["2026-03-01T10:00:00.999999999999999999Z", undefined],
    ["2026-03-01T10:00:00.1000001Z", undefined],
    // Minute-precision form stays accepted (fork wire contract).
    ["2026-03-01T10:00Z", Date.UTC(2026, 2, 1, 10, 0, 0)],
    ["2026-03-01T10:00+05:30", Date.UTC(2026, 2, 1, 4, 30, 0)],
    // Impossible calendar values / range / shapes fail closed.
    ["2023-02-29T10:00:00Z", undefined],
    ["2023-02-30T10:00:00Z", undefined],
    ["2023-04-31T10:00:00+02:00", undefined],
    ["2024-02-29T10:00:00Z", Date.UTC(2024, 1, 29, 10, 0, 0)],
    // Year 0 is the REAL year 0 (the year-safe utcMs bypass maps 0..99),
    // NOT `Date.UTC(0, ...)` -> 1900.
    ["0000-02-29T10:00:00Z", -62162085600000], // real year 0, not 1900
    ["2026-03-01T24:00:00Z", undefined],
    ["2026-03-01T10:60:00Z", undefined],
    ["2026-03-01T10:00:60Z", undefined],
    ["2026-03-01T10:00:00+24:00", undefined],
    // All-day DATE / naive / empty / overlong / malformed fail closed.
    ["2026-03-01", undefined],
    ["2026-03-01T10:00:00", undefined],
    ["", undefined],
    ["2026-03-01T10:00:00.xZ", undefined],
    ["x".repeat(129), undefined],
  ];

  it("classifies every boundary case consistently", () => {
    for (const [value, expected] of cases) {
      const instant = parseStrictCalendarInstantMs(value);
      expect(instant, value).toBe(expected);
      expect(isStrictCalendarInstant(value), value).toBe(
        expected !== undefined,
      );
    }
  });

  it("rejects a bare `Date.parse`-loose string the grammar forbids", () => {
    // `Date.parse` rollover must never widen acceptance on the seconds form.
    expect(isStrictCalendarInstant("2023-02-30T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-02-30T10:00Z")).toBe(false);
  });
});
