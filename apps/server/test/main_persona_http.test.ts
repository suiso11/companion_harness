// Main-conversation persona HTTP: real Hono app, real migrated kernel DB.
import { createMainPersonaStore } from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createCollectingLogger } from "../src/logger.js";
import { createServerFixtureContext } from "./server_fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

async function makeFixture(options: { wired?: boolean } = {}) {
  const { handle, repo, config, engine } =
    await createServerFixtureContext(cleanups);
  const mainPersona = createMainPersonaStore({ db: handle.raw });
  const { app } = createApp({
    config,
    repo,
    engine,
    logger: createCollectingLogger("debug").logger,
    ...(options.wired === false ? {} : { mainPersona }),
  });
  return {
    mainPersona,
    request: async (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

describe("main persona routes", () => {
  it("reads empty, saves, reads back, and clears", async () => {
    const f = await makeFixture();
    const empty = await f.request("/api/main-persona");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ instructions: "", updatedAt: null });

    const saved = await f.request("/api/main-persona", "PUT", {
      instructions: "落ち着いた口調で、簡潔に話す。",
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      instructions: string;
      updatedAt: number | null;
    };
    expect(body.instructions).toBe("落ち着いた口調で、簡潔に話す。");
    expect(body.updatedAt).toBeTypeOf("number");

    const read = await f.request("/api/main-persona");
    expect(await read.json()).toMatchObject({
      instructions: "落ち着いた口調で、簡潔に話す。",
    });

    const cleared = await f.request("/api/main-persona", "PUT", {
      instructions: "",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ instructions: "", updatedAt: null });
  });

  it("rejects over-long instructions and NUL", async () => {
    const f = await makeFixture();
    expect(
      (
        await f.request("/api/main-persona", "PUT", {
          instructions: "x".repeat(4001),
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request("/api/main-persona", "PUT", { instructions: "a\0b" }))
        .status,
    ).toBe(400);
    expect(
      (await f.request("/api/main-persona", "PUT", { bogus: 1 })).status,
    ).toBe(400);
  });

  it("404s when the store is not wired", async () => {
    const f = await makeFixture({ wired: false });
    expect((await f.request("/api/main-persona")).status).toBe(404);
    expect(
      (await f.request("/api/main-persona", "PUT", { instructions: "x" }))
        .status,
    ).toBe(404);
  });
});
