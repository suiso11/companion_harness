// Shared speaker-grounding helpers for structured conversation extraction.
//
// Both memory extraction (#142) and learning extraction send an accepted turn
// to the same LOCAL gateway. The two speaker turns are untrusted model-facing
// data, so each is wrapped in `<user_message>` / `<assistant_message>` tags and
// entity-escaped; a model-supplied `evidence` quote is then accepted as
// "user-stated" ONLY when it is a verbatim (NFKC + whitespace-normalized)
// substring of the user's own turn. Quoting the assistant can never promote a
// claim to user-confirmed. These helpers are pure and shared so the two
// pipelines cannot drift apart.

/**
 * Escape a speaker segment so content cannot close or open the extraction
 * delimiters (`<user_message>`, `<assistant_message>`). Both speaker blocks
 * are model-facing untrusted data; entity escaping is the only transformation
 * (no paraphrasing), so the model still sees the user's own words.
 */
export function escapeExtractionDelimiters(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Reverse `escapeExtractionDelimiters` for a model-supplied evidence quote. */
export function unescapeExtractionDelimiters(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Grounding normalization: NFKC plus whitespace collapse/trim. This only
 * forgives formatting differences between a verbatim quote and the user's
 * turn; it never paraphrases and is deliberately case-sensitive.
 */
export function normalizeExtractionGrounding(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * True only when `quote` is a non-empty verbatim substring of `source` after
 * grounding normalization. An empty quote never grounds anything.
 */
export function isGroundedExtractionQuote(
  quote: string,
  source: string,
): boolean {
  const normalizedQuote = normalizeExtractionGrounding(
    unescapeExtractionDelimiters(quote),
  );
  if (normalizedQuote.length === 0) return false;
  return normalizeExtractionGrounding(source).includes(normalizedQuote);
}
