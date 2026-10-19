// @vitest-environment jsdom
// V2 markdown unit tests: validated-answer rendering is sanitized HTML
// with code highlighting. No network, no Svelte, pure pipeline.
import { describe, expect, test } from "vitest";
import { renderAnswerMarkdown } from "../src/lib/markdown.js";

describe("renderAnswerMarkdown", () => {
  test("renders a list as list elements", () => {
    const html = renderAnswerMarkdown("- one\n- two\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  test("highlights fenced code and adds the copy chrome", () => {
    const html = renderAnswerMarkdown(
      "```typescript\nconst x: number = 1;\n```\n",
    );
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("copy-code-btn");
    expect(html).toContain("data-code-id");
    // rehype-highlight ran on the registered subset.
    expect(html).toContain("language-typescript");
    expect(html).toContain("hljs");
  });

  test("leaves unregistered languages as static source", () => {
    const html = renderAnswerMarkdown("```mermaid\ngraph TD;\n```\n");
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("graph TD;");
  });

  test("shows raw HTML as literal text, never elements", () => {
    const html = renderAnswerMarkdown('<script>alert("x")</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain('alert("x")');
  });

  test("shows event-handler markup as inert text, never elements", () => {
    const html = renderAnswerMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toMatch(/<img[\s>]/);
    // The payload survives only as escaped text (no executable attribute).
    expect(html).toContain("onerror");
    expect(html).toContain("&#x3C;");
  });

  test("strips javascript: link targets", () => {
    const html = renderAnswerMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  test("hardens normal links with blank target and noopener", () => {
    const html = renderAnswerMarkdown("[docs](https://example.com/)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("strips remote images, keeping alt text", () => {
    const html = renderAnswerMarkdown("![alt text](https://example.com/x.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.com/x.png");
    expect(html).toContain("alt text");
  });

  test("does not turn citation-like tokens into links", () => {
    const html = renderAnswerMarkdown("see r1 and m2 for details");
    expect(html).not.toContain("<a");
    expect(html).toContain("r1");
    expect(html).toContain("m2");
  });

  test("keeps ordered-list start numbers", () => {
    const html = renderAnswerMarkdown("3. three\n4. four\n");
    expect(html).toContain("<ol");
    expect(html).toContain('start="3"');
  });

  test("keeps task-list checkboxes disabled and drops other inputs", () => {
    const checked = renderAnswerMarkdown("- [x] done\n- [ ] todo\n");
    expect(checked).toMatch(/<input[^>]*type="checkbox"/);
    expect(checked).toContain("disabled");
    // Only checkbox inputs survive: no text inputs, no bare type attrs.
    expect(checked).not.toMatch(/type="text"/);
    const hostile = renderAnswerMarkdown(
      '<input type="text" value="steal" onfocus="alert(1)">',
    );
    expect(hostile).not.toMatch(/<input[\s>]/);
  });

  test("preserves GFM table column alignment as classes", () => {
    const html = renderAnswerMarkdown(
      "| a | b | c |\n| --- | ---: | :---: |\n| 1 | 2 | 3 |\n",
    );
    // Left-aligned columns get no class (default `text-align: start`);
    // center/right columns are carried through as classes.
    expect(html).toContain("md-align-right");
    expect(html).toContain("md-align-center");
    expect(html).not.toContain("md-align-left");
    // Deprecated align attribute must not survive sanitization.
    expect(html).not.toMatch(/\salign=/);
  });

  test("returns empty string for empty input", () => {
    expect(renderAnswerMarkdown("")).toBe("");
  });
});
