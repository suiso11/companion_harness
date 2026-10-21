// Fixed-task comparison CLI over the REAL RunEngine/AgentStrategy, using a
// labelled local synthetic model HTTP fixture (not a real model). Proves
// that both runs produce actual answers/citations/tool use/tokens/duration
// evidence, that the variant guidance is APPENDED to the immutable base
// prompt, and that all state stays inside the dedicated experimental
// directory.

import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCompareInput,
  runCompareCli,
  toSafeCompareCliMessage,
} from "../src/compare_cli.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "compare-cli-"));
  roots.push(root);
  return root;
}

async function readBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startFixture(): Promise<{
  baseUrl: string;
  systemPrompts: string[];
  advertisedTools: string[][];
}> {
  const systemPrompts: string[] = [];
  const advertisedTools: string[][] = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as {
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ type: string; function: { name: string } }>;
    };
    const system = body.messages.find((message) => message.role === "system");
    systemPrompts.push(system?.content ?? "");
    const toolNames = (body.tools ?? []).map((tool) => tool.function.name);
    advertisedTools.push(toolNames);
    const hasToolResult = body.messages.some(
      (message) => message.role === "tool",
    );
    const variant = (system?.content ?? "").includes("VARIANT-GUIDANCE");
    // The fixture only consumes tools the Agent actually advertised. If the
    // docs tool is missing it answers without evidence (and the citation
    // assertion below fails) instead of invoking an invisible tool by fiat.
    const docsTool = toolNames.includes("experiment.read");
    const toolResult = body.messages.find((message) => message.role === "tool");
    let ordinal = 1;
    if (hasToolResult && toolResult !== undefined) {
      const parsed = JSON.parse(toolResult.content) as {
        ok: boolean;
        output: { ordinal: number } | null;
      };
      if (parsed.ok && parsed.output !== null) {
        ordinal = parsed.output.ordinal;
      }
    }
    const message = hasToolResult
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "answer-1",
              function: {
                name: "answer.submit",
                arguments: {
                  version: 1,
                  parts: [
                    {
                      text: variant ? "variant answer" : "baseline answer",
                      citations: hasToolResult ? [`r${ordinal}`] : [],
                    },
                  ],
                },
              },
            },
          ],
        }
      : docsTool
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool-1",
                function: {
                  name: "experiment.read",
                  arguments: { key: "doc-a" },
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "answer-1",
                function: {
                  name: "answer.submit",
                  arguments: {
                    version: 1,
                    parts: [
                      {
                        text: variant ? "variant answer" : "baseline answer",
                        citations: [],
                      },
                    ],
                  },
                },
              },
            ],
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "fixture-model",
        message,
        done: hasToolResult,
        done_reason: hasToolResult ? "stop" : "tool_calls",
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    systemPrompts,
    advertisedTools,
  };
}

describe("fixed-task comparison CLI", () => {
  it("runs baseline + variant with actual evidence in dedicated storage", async () => {
    const root = tempRoot();
    const docPath = join(root, "doc-a.md");
    writeFileSync(docPath, "# Alpha\n\nThe answer is alpha.\n");
    const storage = join(root, "experiment");
    const inputPath = join(root, "input.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        version: 1,
        prompt: "What does the fixed document say?",
        docs: [{ key: "doc-a", path: docPath, title: "Alpha" }],
        storageDirectory: storage,
        variant: {
          label: "guided",
          systemPrompt: "VARIANT-GUIDANCE: answer with one short sentence.",
        },
        timeoutMs: 20_000,
      }),
    );
    const fixture = await startFixture();
    const env = {
      COMPANION_MODEL_JSON: JSON.stringify({
        adapter: "ollama",
        baseUrl: fixture.baseUrl,
        model: "fixture-model",
      }),
    };
    const output = JSON.parse(await runCompareCli([inputPath], env)) as {
      model: { adapter: string; model: string; apiKey?: string };
      baseline: {
        status: string;
        answer: { parts: Array<{ text: string; citations: string[] }> } | null;
        citations: string[];
        tokens: { inputTokens: number; outputTokens: number } | null;
        toolCalls: Array<{ tool: string; outcome: string | null }>;
        privateRecords: { count: number; kinds: string[] } | null;
        durationMs: number;
      };
      variant: {
        status: string;
        answer: { parts: Array<{ text: string; citations: string[] }> } | null;
        citations: string[];
      };
      experimentalStorage: string;
    };
    expect(output.model).toEqual({ adapter: "ollama", model: "fixture-model" });
    expect(output.baseline.status).toBe("completed");
    expect(output.variant.status).toBe("completed");
    expect(output.baseline.answer?.parts[0]?.text).toBe("baseline answer");
    expect(output.variant.answer?.parts[0]?.text).toBe("variant answer");
    expect(output.baseline.citations).toEqual(["r1"]);
    expect(output.variant.citations).toEqual(["r1"]);
    // Two model calls per run (advertised docs tool, then cited answer).
    expect(output.baseline.tokens).toEqual({
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(output.baseline.toolCalls).toEqual([
      expect.objectContaining({
        tool: "experiment.read",
        outcome: "succeeded",
      }),
    ]);
    expect(output.baseline.durationMs).toBeGreaterThanOrEqual(0);
    expect(output.baseline.privateRecords?.count).toBeGreaterThan(0);
    expect(output.baseline.privateRecords?.kinds).toEqual(
      expect.arrayContaining([
        "model.request",
        "model.response.raw",
        "tool.input",
        "tool.result",
      ]),
    );
    expect(output.experimentalStorage.startsWith(storage)).toBe(true);
    expect(
      readdirSync(storage).some((name) => name.startsWith("comparison-")),
    ).toBe(true);

    // The docs tool must be advertised to the model; the synthetic model
    // above calls it only when present, and its returned ordinal is the exact
    // citation validated by the Agent's structural citation gate.
    expect(fixture.advertisedTools.length).toBe(4);
    for (const tools of fixture.advertisedTools) {
      expect(tools).toContain("experiment.read");
      expect(tools).toContain("answer.submit");
      // Production Web/Calendar/MCP/memory tools are never registered here.
      expect(tools).not.toContain("web.search");
      expect(tools).not.toContain("calendar.search");
      expect(tools).not.toContain("memory.search");
      expect(tools).not.toContain("markdown.search");
    }
    // Evidence only: the CLI never fabricates a score.
    expect(output).not.toHaveProperty("scores");
    expect(output.baseline).not.toHaveProperty("score");
    expect(output.variant).not.toHaveProperty("score");

    // Base safety instructions are never replaced; variant guidance is
    // appended only to the variant run.
    expect(fixture.systemPrompts.length).toBe(4);
    for (const prompt of fixture.systemPrompts) {
      expect(prompt).toContain("read-only research assistant");
    }
    expect(
      fixture.systemPrompts.filter((prompt) =>
        prompt.includes("VARIANT-GUIDANCE"),
      ),
    ).toHaveLength(2);
  });

  it("validates input paths and returns fixed safe errors", () => {
    const root = tempRoot();
    const docPath = join(root, "doc.md");
    writeFileSync(docPath, "text");
    const base = {
      version: 1,
      prompt: "task",
      docs: [{ key: "doc-a", path: docPath }],
      storageDirectory: root,
      variant: { label: "v", systemPrompt: "guide" },
    };
    expect(() =>
      parseCompareInput(
        JSON.stringify({ ...base, storageDirectory: "relative/path" }),
      ),
    ).toThrow(/storageDirectory must be absolute/);
    expect(() =>
      parseCompareInput(JSON.stringify({ ...base, version: 2 })),
    ).toThrow(/version must be 1/);
    expect(() =>
      parseCompareInput(JSON.stringify({ ...base, docs: [] })),
    ).toThrow(/docs must contain/);
    expect(() =>
      parseCompareInput(JSON.stringify({ ...base, variant: { label: "v" } })),
    ).toThrow(/systemPrompt is invalid/);
    expect(toSafeCompareCliMessage(new Error("raw /tmp/payload"))).toBe(
      "compare failed",
    );

    if (process.platform !== "win32") {
      const link = join(root, "link.md");
      symlinkSync(docPath, link);
      expect(() =>
        parseCompareInput(
          JSON.stringify({
            ...base,
            docs: [{ key: "doc-a", path: link }],
          }),
        ),
      ).toThrow(/regular file/);
    }
  });
});
