// Display-only guard against upstream descriptions that contain the same block
// twice -- a rare Grants.gov summary_description quirk (~0.3% of records; issue
// #73). Collapses a repeated block for RENDERING only; the stored column is never
// mutated. Conservative by design -- eating real content is worse than showing a
// rare double, so it compares on a normalized key (tags stripped, whitespace
// collapsed, lowercased), only acts on a substantial (>= 40 normalized chars)
// duplicated unit, removes only CONSECUTIVE duplicates (so a legitimately repeated
// phrase with content between it, "A B A", is left fully intact), and returns the
// input UNCHANGED whenever it is not confident.
const MIN_DUP_LEN = 40;

function normalizeKey(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function collapseDuplicatedBlock(raw: string): string {
  if (!raw) return raw;

  // Strategy 1 -- consecutive duplicate blocks. Split on paragraph boundaries
  // (after each </p> for HTML, else on blank lines) and drop a block whose
  // normalized key equals the previous KEPT block's key. Consecutive-only, so
  // "A B A" survives; only "A A" collapses.
  const isHtml = /<\/p>/i.test(raw);
  const blocks = isHtml ? raw.split(/(?<=<\/p>)/i) : raw.split(/\n\s*\n/);
  if (blocks.length > 1) {
    const kept: string[] = [];
    let prevKey = "";
    for (const b of blocks) {
      const key = normalizeKey(b);
      if (key && key === prevKey && key.length >= MIN_DUP_LEN) continue; // drop consecutive dup
      kept.push(b);
      if (key) prevKey = key;
    }
    if (kept.length < blocks.length) return isHtml ? kept.join("") : kept.join("\n\n");
  }

  // Strategy 2 -- a single block that is exactly its own content twice ("AA", no
  // separator). Byte-identical halves are unambiguous duplication (natural prose
  // is never two equal halves), so this needs no normalization and can't false-fire.
  const t = raw.trim();
  if (t.length >= MIN_DUP_LEN * 2 && t.length % 2 === 0) {
    const half = t.length / 2;
    if (t.slice(0, half) === t.slice(half)) return t.slice(0, half).trim();
  }

  return raw;
}

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
