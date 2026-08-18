// Title emphasis for the client-facing grant surfaces — the alert card hero and the grant
// report main box. Italic-orange the single most DISTINCTIVE word: the longest content word,
// skipping short words and stopwords, falling back to the last word. Deterministic (no LLM at
// render), and it reproduces Design's pick ("Scholarships for Disadvantaged Students" →
// "Disadvantaged").
const TITLE_STOPWORDS = new Set([
  "for", "of", "the", "and", "to", "in", "a", "an", "on", "with", "from", "by", "or", "at", "as", "its", "your",
]);

export function titleParts(title: string): { text: string; em: boolean }[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.map((text) => ({ text, em: false }));
  let idx = -1;
  let best = 0;
  words.forEach((w, i) => {
    const clean = w.replace(/[^A-Za-z-]/g, "");
    if (clean.length < 6 || TITLE_STOPWORDS.has(clean.toLowerCase())) return;
    if (clean.length > best) {
      best = clean.length;
      idx = i;
    }
  });
  if (idx === -1) idx = words.length - 1; // nothing qualified → the last word
  return words.map((text, i) => ({ text, em: i === idx }));
}

// Split a trailing "(ACRONYM)" off a title so the report hero can de-emphasise it (grey),
// e.g. "Scholarships for Disadvantaged Students (SDS)" → { head, tail: "(SDS)" }. No trailing
// parenthetical → the whole string is the head and tail is null.
export function splitTrailingParenthetical(title: string): { head: string; tail: string | null } {
  const m = title.trim().match(/^(.*\S)\s+(\([^()]+\))$/);
  return m ? { head: m[1], tail: m[2] } : { head: title.trim(), tail: null };
}
