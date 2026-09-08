// Provider-native tool-call id/name bounds (m2-tool-id-name-bounds).
//
// Bounds: id 1..256 chars (replay-safe, matches history validation),
// name 1..128 chars in lowercase namespace.verb shape (contracts
// ToolNameSchema; answer.submit preserved). Empty/control-bearing/
// misshaped ids/names reject as fixed redacted tool_call_invalid,
// oversize as fixed redacted invalid_response. Never truncated, never
// echoed. Unknown but well-formed ordinary names pass the gateway so
// ToolBroker applies authoritative unknown-tool budget/audit. Atomic:
// one bad call rejects the whole response.
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "id-name-secret-must-not-leak-9z9z";
const KNOWN = [{ name: "notes.search", description: "search" }];

function valid128Name(): string {
  return `${"a".repeat(63)}.${"b".repeat(64)}`;
}
function over128Name(): string {
  return `${"a".repeat(64)}.${"b".repeat(64)}`;
}

function openaiBody(calls: unknown[]): unknown {
  return {
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: calls },
        finish_reason: "tool_calls",
      },
    ],
  };
}
function ollamaBody(calls: unknown[]): unknown {
  return {
    message: { role: "assistant", content: "", tool_calls: calls },
    done: true,
  };
}
function openaiCall(id: unknown, name: unknown): unknown {
  return {
    id,
    type: "function",
    function: { name, arguments: {} },
  };
}
function ollamaCall(id: unknown, name: unknown): unknown {
  const entry: Record<string, unknown> = {
    function: { name, arguments: {} },
  };
  if (id !== undefined) entry.id = id;
  return entry;
}

function expectCode(
  fn: () => unknown,
  code: "tool_call_invalid" | "invalid_response",
): void {
  try {
    fn();
    expect.unreachable("should reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelLocalError);
    expect((error as ModelLocalError).code).toBe(code);
    expect((error as ModelLocalError).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  }
}

describe("tool id bounds (both providers)", () => {
  it("accepts exactly 256-char ids and preserves wire correlation", () => {
    const id = "x".repeat(256);
    const oai = normalizeOpenAIResponse(
      openaiBody([openaiCall(id, "notes.search")]),
      KNOWN,
    );
    expect(oai.toolCalls[0]?.id).toBe(id);
    const ol = normalizeOllamaResponse(
      ollamaBody([ollamaCall(id, "notes.search")]),
      KNOWN,
    );
    expect(ol.toolCalls[0]?.id).toBe(id);
    expect(ol.toolCalls[0]?.name).toBe("notes.search");
  });

  it("rejects 257-char ids as oversize invalid_response without echo", () => {
    const id = `${SECRET}${"x".repeat(257)}`.slice(0, 257);
    expectCode(
      () =>
        normalizeOpenAIResponse(
          openaiBody([openaiCall(id, "notes.search")]),
          KNOWN,
        ),
      "invalid_response",
    );
    expectCode(
      () =>
        normalizeOllamaResponse(
          ollamaBody([ollamaCall(id, "notes.search")]),
          KNOWN,
        ),
      "invalid_response",
    );
  });

  it("rejects empty/non-string/control-bearing ids as tool_call_invalid", () => {
    for (const bad of ["", `a${SECRET}\nbad`, "bad\u0000id", 42, {}]) {
      expectCode(
        () =>
          normalizeOpenAIResponse(
            openaiBody([openaiCall(bad, "notes.search")]),
            KNOWN,
          ),
        "tool_call_invalid",
      );
      expectCode(
        () =>
          normalizeOllamaResponse(
            ollamaBody([ollamaCall(bad, "notes.search")]),
            KNOWN,
          ),
        "tool_call_invalid",
      );
    }
  });

  it("synthesizes absent ids as finite replay-safe call_<index>", () => {
    const oai = normalizeOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  type: "function",
                  function: { name: "notes.search", arguments: {} },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      KNOWN,
    );
    expect(oai.toolCalls[0]?.id).toBe("call_0");
    const ol = normalizeOllamaResponse(
      ollamaBody([{ function: { name: "notes.search", arguments: {} } }]),
      KNOWN,
    );
    expect(ol.toolCalls[0]?.id).toBe("call_0");
  });
});

describe("tool name bounds (both providers)", () => {
  it("accepts exactly 128-char namespace.verb and preserves answer.submit", () => {
    const name128 = valid128Name();
    expect(name128.length).toBe(128);
    for (const name of [name128, "answer.submit", "notes.search"]) {
      const oai = normalizeOpenAIResponse(
        openaiBody([openaiCall("c1", name)]),
        [
          { name: "notes.search", description: "s" },
          { name: "answer.submit", description: "a" },
          { name: name128, description: "b" },
        ],
      );
      expect(oai.toolCalls[0]?.name).toBe(name);
      const ol = normalizeOllamaResponse(ollamaBody([ollamaCall("c1", name)]), [
        { name: "notes.search", description: "s" },
        { name: "answer.submit", description: "a" },
        { name: name128, description: "b" },
      ]);
      expect(ol.toolCalls[0]?.name).toBe(name);
    }
  });

  it("rejects 129-char names as oversize invalid_response without echo", () => {
    const name = over128Name();
    expect(name.length).toBe(129);
    expectCode(
      () =>
        normalizeOpenAIResponse(openaiBody([openaiCall("c1", name)]), KNOWN),
      "invalid_response",
    );
    expectCode(
      () =>
        normalizeOllamaResponse(ollamaBody([ollamaCall("c1", name)]), KNOWN),
      "invalid_response",
    );
  });

  it("rejects empty/control-bearing/misshaped names as tool_call_invalid", () => {
    for (const bad of [
      "",
      `evil\n${SECRET}`,
      "bad\u007Fname",
      "UPPER.verb",
      "no-dot",
      "notes.Search",
      "notes.search ",
      ".verb",
      "ns.",
      42,
    ]) {
      expectCode(
        () =>
          normalizeOpenAIResponse(openaiBody([openaiCall("c1", bad)]), KNOWN),
        "tool_call_invalid",
      );
      expectCode(
        () =>
          normalizeOllamaResponse(ollamaBody([ollamaCall("c1", bad)]), KNOWN),
        "tool_call_invalid",
      );
    }
  });

  it("passes unknown but well-formed ordinary names to the broker (no gateway reject)", () => {
    const oai = normalizeOpenAIResponse(
      openaiBody([openaiCall("c9", "unknown.tool")]),
      KNOWN,
    );
    expect(oai.toolCalls).toEqual([
      { id: "c9", name: "unknown.tool", arguments: {} },
    ]);
    const ol = normalizeOllamaResponse(
      ollamaBody([ollamaCall("c9", "unknown.tool")]),
      KNOWN,
    );
    expect(ol.toolCalls).toEqual([
      { id: "c9", name: "unknown.tool", arguments: {} },
    ]);
  });
});

describe("multi-call atomicity", () => {
  it("rejects the whole response when one of several calls is invalid", () => {
    const good = openaiCall("ok-1", "notes.search");
    const badId = openaiCall("x".repeat(257), "notes.search");
    expectCode(
      () => normalizeOpenAIResponse(openaiBody([good, badId]), KNOWN),
      "invalid_response",
    );
    const badName = openaiCall("ok-2", "BAD.name");
    expectCode(
      () => normalizeOpenAIResponse(openaiBody([good, badName]), KNOWN),
      "tool_call_invalid",
    );

    const ogood = ollamaCall("ok-1", "notes.search");
    const obadId = ollamaCall(`bad${SECRET}`, "notes.search");
    // control-free but misshaped second call still rejects atomically
    expectCode(
      () =>
        normalizeOllamaResponse(
          ollamaBody([ogood, ollamaCall("ok-2", "BAD.name")]),
          KNOWN,
        ),
      "tool_call_invalid",
    );
    void obadId;
  });

  it("accepts multi-call well-formed batches with wire ids/names intact", () => {
    const calls = [
      openaiCall("c0", "notes.search"),
      openaiCall("c1", "unknown.tool"),
    ];
    const result = normalizeOpenAIResponse(openaiBody(calls), KNOWN);
    expect(result.toolCalls.map((c) => c.id)).toEqual(["c0", "c1"]);
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      "notes.search",
      "unknown.tool",
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });
});
