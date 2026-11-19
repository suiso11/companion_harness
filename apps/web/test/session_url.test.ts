import { describe, expect, test } from "vitest";
import { sessionFromSearch } from "../src/lib/session_url.js";

const ID = "912dcf8a-fee7-4836-8e21-4575b90c7361";

describe("session deep link", () => {
  test("adopts a valid uuid and normalizes case", () => {
    expect(sessionFromSearch(`?session=${ID}`)).toBe(ID);
    expect(sessionFromSearch(`?a=1&session=${ID.toUpperCase()}`)).toBe(ID);
  });

  test("ignores missing or malformed values", () => {
    expect(sessionFromSearch("")).toBeNull();
    expect(sessionFromSearch("?session=not-a-uuid")).toBeNull();
    expect(sessionFromSearch("?session=")).toBeNull();
  });
});
