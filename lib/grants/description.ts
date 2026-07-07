// Word-count preview of a sanitized description HTML for the "What it funds"
// column, with a "Show more" expander (see components/grants/expandable-description).
// Pure string logic (no deps): walks the HTML, counts words in text nodes, and
// once past the target keeps going until the next SENTENCE end -- so it never
// cuts mid-sentence -- then closes any open tags so the markup stays valid.
// Inline formatting (strong/em) and block structure up to the cut are preserved.

const VOID = new Set(["br"]);

export function previewHtml(html: string, maxWords = 140): { html: string; truncated: boolean } {
  const total = (html.replace(/<[^>]+>/g, " ").match(/\S+/g) || []).length;
  if (total <= maxWords) return { html, truncated: false };

  const tokens = html.match(/<[^>]+>|[^<]+/g) || [];
  const stack: string[] = [];
  let words = 0;
  let out = "";
  let stop = false;

  for (const tok of tokens) {
    if (stop) break;
    if (tok[0] === "<") {
      out += tok;
      const close = tok.match(/^<\/([a-z0-9]+)/i);
      const open = tok.match(/^<([a-z0-9]+)/i);
      if (close) {
        const i = stack.lastIndexOf(close[1].toLowerCase());
        if (i >= 0) stack.splice(i, 1);
      } else if (open && !tok.endsWith("/>")) {
        const t = open[1].toLowerCase();
        if (!VOID.has(t)) stack.push(t);
      }
      continue;
    }
    // Text node: emit word-by-word; after the target, stop at the first
    // sentence-ending word.
    const parts = tok.match(/\s+|\S+/g) || [];
    let piece = "";
    for (const w of parts) {
      piece += w;
      if (/\S/.test(w)) {
        words++;
        if (words >= maxWords && /[.!?]["'’)\]]?$/.test(w)) {
          stop = true;
          break;
        }
      }
    }
    out += piece;
  }

  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
  return { html: out, truncated: stop };
}
