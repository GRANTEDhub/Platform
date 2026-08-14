// Shared, client-safe helpers for bounding untrusted text before it reaches the model: the
// pasted-content frame's label sanitiser and the char-cap truncator. Kept together, zero imports,
// so both the server frame (prompt.ts / web-fetch.ts) and the client file-attach path
// (grantbot-chat.tsx) import them from one place and cannot drift.
//
// stripControlChars: single source for the pasted-content frame's label sanitiser.
//
// The label rides the PASTED_OPEN marker line (framePastedContent) ahead of the untrusted-content
// disclaimer, so ANY character that renders as a forced line break would let a crafted label (a POSIX
// filename may legally contain them) span multiple lines and forge a `>>> END PASTED CONTENT` fence --
// the break-out the frame exists to stop. Strip every recognised line-breaking code point, not just
// `\n`: ASCII C0 controls + DEL (U+0000-001F, U+007F), the C1 range incl. NEL U+0085 (U+0080-009F),
// and the Unicode LINE / PARAGRAPH separators (U+2028 / U+2029).
//
// Kept in ONE place so the server frame (prompt.ts) and the client file-attach label
// (grantbot-chat.tsx) cannot drift -- the same reason PASTED_OPEN / PASTED_CLOSE are shared constants.
// Client-safe by construction: zero imports, so a "use client" component pulls in nothing else.
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").trim();
}

// Char-cap a string for the model's context window. slice() cuts on UTF-16 code units, so a cut
// landing inside an astral character's surrogate pair would leave a dangling lone high surrogate --
// drop it. Shared by the web-fetch char cap (web-fetch.ts) and the file-attach cap (grantbot-chat.tsx)
// so the two truncation sites cannot drift, the same reason stripControlChars is shared.
export function truncateSafely(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let out = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

