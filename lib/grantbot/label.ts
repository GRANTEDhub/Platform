// Single source for the pasted-content frame's label sanitiser.
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
