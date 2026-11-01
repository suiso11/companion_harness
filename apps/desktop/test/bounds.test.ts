import { describe, expect, test } from "vitest";
import { pickBounds } from "../bounds.cjs";

const filled = { x: 100, y: 80, width: 360, height: 560 };
const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];

describe("pickBounds", () => {
  test("restores a saved rectangle that is still on a display", () => {
    expect(pickBounds(filled, displays)).toEqual(filled);
  });

  test("restores a rectangle that only partly overlaps a display", () => {
    expect(pickBounds({ ...filled, x: 1800 }, displays)).toEqual({
      ...filled,
      x: 1800,
    });
  });

  test("drops a rectangle whose monitor is gone", () => {
    expect(pickBounds({ ...filled, x: 5000 }, displays)).toEqual({});
  });

  test("drops non-integral, tiny and malformed state", () => {
    expect(pickBounds({ ...filled, width: 99 }, displays)).toEqual({});
    expect(pickBounds({ ...filled, x: 1.5 }, displays)).toEqual({});
    expect(pickBounds({ x: 1, y: 2 }, displays)).toEqual({});
    expect(pickBounds(null, displays)).toEqual({});
    expect(pickBounds("nope", displays)).toEqual({});
  });
});
