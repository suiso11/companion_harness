// Shared temporal rendering: the frozen Turn zone is authoritative, invalid
// zones/instants fail closed, and only canonical ISO instants are carried.
import { describe, expect, it } from "vitest";
import {
  formatCurrentDateTimeLine,
  formatMemoryDateSuffix,
  formatZonedDate,
  formatZonedDateTime,
  isCanonicalIsoInstant,
} from "../src/index.js";

describe("formatZonedDateTime", () => {
  it("renders an instant in the configured IANA zone", () => {
    expect(
      formatZonedDateTime(Date.parse("2026-10-22T18:30:00.000Z"), "Asia/Tokyo"),
    ).toBe("2026-10-23 (金) 03:30");
  });

  it("rejects an invalid zone", () => {
    expect(
      formatZonedDateTime(Date.parse("2026-10-22T18:30:00.000Z"), "Not/AZone"),
    ).toBe(null);
  });
});

describe("formatZonedDate", () => {
  it("renders only the date in the zone", () => {
    expect(formatZonedDate("2026-10-22T18:30:00.000Z", "Asia/Tokyo")).toBe(
      "2026-10-23",
    );
  });
  it("rejects invalid values", () => {
    expect(formatZonedDate("not-a-date", "Asia/Tokyo")).toBe(null);
  });
});

describe("formatMemoryDateSuffix", () => {
  it("renders the 記録 date when createdAt is present", () => {
    expect(
      formatMemoryDateSuffix("2026-10-22T18:30:00.000Z", "Asia/Tokyo"),
    ).toBe(" (記録: 2026-10-23)");
  });
  it("returns null when invalid", () => {
    expect(formatMemoryDateSuffix("nope", "Asia/Tokyo")).toBe(null);
  });
});

describe("formatCurrentDateTimeLine", () => {
  it("includes the zone token", () => {
    expect(
      formatCurrentDateTimeLine(
        Date.parse("2026-10-22T18:30:00.000Z"),
        "Asia/Tokyo",
      ),
    ).toBe("現在日時: 2026-10-23 (金) 03:30 Asia/Tokyo");
  });
});

describe("isCanonicalIsoInstant", () => {
  it("accepts the Date#toISOString round-trip", () => {
    expect(isCanonicalIsoInstant("2026-10-22T18:30:00.000Z")).toBe(true);
  });
  it("rejects offset, date-only, and malformed forms", () => {
    expect(isCanonicalIsoInstant("2026-10-23T03:30:00+09:00")).toBe(false);
    expect(isCanonicalIsoInstant("2026-10-23")).toBe(false);
    expect(isCanonicalIsoInstant("oops")).toBe(false);
    expect(isCanonicalIsoInstant(undefined)).toBe(false);
  });
});
