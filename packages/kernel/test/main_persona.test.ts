import { afterEach, describe, expect, it } from "vitest";
import { migrateKernelDatabase, openKernelDatabase } from "../src/index.js";
import { createMainPersonaStore } from "../src/main_persona.js";

async function setup() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    handle,
    store: createMainPersonaStore({ db: handle.raw }),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

describe("main persona store", () => {
  it("starts empty and round-trips one row", async () => {
    const { handle, store } = await setup();
    cleanups.push(() => handle.raw.close());
    expect(store.get()).toBeNull();
    expect(store.set("落ち着いた口調で話す", 100)).toEqual({
      instructions: "落ち着いた口調で話す",
      updatedAt: 100,
    });
    expect(store.get()).toEqual({
      instructions: "落ち着いた口調で話す",
      updatedAt: 100,
    });
    expect(store.set("newer", 200)).toEqual({
      instructions: "newer",
      updatedAt: 200,
    });
    const count = handle.raw
      .prepare("SELECT COUNT(*) AS n FROM main_persona")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("clears with an empty string", async () => {
    const { handle, store } = await setup();
    cleanups.push(() => handle.raw.close());
    store.set("x", 1);
    expect(store.set("", 2)).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("rejects over-long instructions and NUL", async () => {
    const { handle, store } = await setup();
    cleanups.push(() => handle.raw.close());
    expect(() => store.set("x".repeat(4001), 1)).toThrow();
    expect(() => store.set("a\0b", 1)).toThrow();
  });
});
