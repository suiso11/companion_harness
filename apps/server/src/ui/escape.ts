// M3 safe-rendering primitive (plan §16.5, §16.7).
//
// Structural XSS defense: every user/model/snapshot string is rendered as
// escaped plain text. No `innerHTML`, no Markdown HTML interpretation, no
// HTML built from external data anywhere (server SSR and client DOM alike).

/** Escape `&<>"'` for safe interpolation into HTML text/attribute slots. */
export function escapeHtml(value: string): string {
  let out = "";
  for (const unit of value) {
    switch (unit) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      default:
        out += unit;
    }
  }
  return out;
}
