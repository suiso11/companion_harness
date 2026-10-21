// Pinned lowlight grammars as ONE lazy chunk (PR112 review).
//
// `markdown.ts` used to `Promise.all` six literal dynamic imports of
// `highlight.js/lib/languages/*`. Rollup emits each as its own Vite chunk
// and all six load concurrently for a code block, but `check-bundle-gz.mjs`
// budgets only the largest single chunk next to the entry: five grammar
// chunks escaped the worst-route total, so the guard could pass while the
// actual code-block load exceeded it. A single dynamically-imported module
// that statically imports the six grammars produces exactly one chunk, so
// the budget again matches what the browser loads.
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";

/** Grammar registry handed to `lowlight.register` after the chunk loads. */
export const highlightGrammars = {
  bash,
  diff,
  json,
  plaintext,
  python,
  typescript,
} as const;
