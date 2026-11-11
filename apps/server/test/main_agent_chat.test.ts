// Real main-agent adapter: a RunEngine strategy turn observed through the
// durable run row, with the persona-chat session reused across turns.
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
  StrategyRegistry,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STRATEGY_NAME } from "../src/bootstrap.js";
import { createMainAgentChat } from "../src/main_agent_chat.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

describe("main agent chat adapter", () => {
  it("runs a real engine turn and reuses one session per chat", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    cleanups.push(() => closeKernelDatabase(handle));
    const repo = createKernelRepository(handle.raw);
    const registry = new StrategyRegistry();
    const prompts: string[] = [];
    registry.register(AGENT_STRATEGY_NAME, async (ctx) => {
      if (ctx.turn.input.kind === "user_text") {
        prompts.push(ctx.turn.input.text);
      }
      return {
        version: 2,
        text: "main says hi",
        answer: {
          version: 1,
          parts: [{ text: "main says hi", citations: [] }],
        },
      };
    });
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      registry,
      pollIntervalMs: 5,
    });
    engine.start();
    cleanups.push(() => void engine.shutdown({ drainMs: 100 }));
    const mainChat = createMainAgentChat({
      repo,
      engine,
      now: Date.now,
      pollMs: 5,
      timeoutMs: 5_000,
    });

    const input = {
      chatId: "00000000-0000-4000-8000-000000000001",
      personaName: "Ada",
      text: "hello",
      transcript: "Ada: hello",
    };
    expect(await mainChat(input)).toBe("main says hi");
    expect(prompts[0]).toContain("Ada: hello");
    expect(prompts[0]).toContain("あなた自身の発言を1つだけ");

    expect(await mainChat({ ...input, text: "again" })).toBe("main says hi");
    expect(prompts[1]).toBe("Ada: again");
    const sessions = handle.raw
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };
    expect(sessions.n).toBe(1);
  });
});
