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

// The file-attach bounds, in ONE client-safe place so the client picker guard (grantbot-chat.tsx)
// and the server extract route (extract-file.ts) enforce the SAME limits and cannot drift.
//   CHARS  — the model-context cap applied via truncateSafely (generous for email threads / NOFOs).
//   BYTES  — a READ guard: readAsText / the server buffer both hold the whole file in memory before
//            the char cap ever runs, so a size guard mirrors web-fetch's MAX_RESPONSE_BYTES on the wire.
export const MAX_ATTACH_CHARS = 200_000;
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

// Which server extractor an attached file needs, by extension (preferred) then MIME — or null for
// anything that is not a .pdf or .docx (a text file, which the client reads itself; the server route
// rejects null as unsupported_type). Pure string logic, zero imports, so the client (grantbot-chat.tsx,
// to route a binary to the extract route) and the server (extract-file.ts, to pick the parser) share
// ONE definition and cannot disagree on what counts as a document. Legacy binary .doc is deliberately
// NOT matched — mammoth reads OOXML .docx only.
export function attachKindFor(fileName: string, mime?: string): "pdf" | "docx" | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (
    lower.endsWith(".docx") ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  return null;
}

// Genuinely plain-text formats the client may read with FileReader.readAsText. This is a WHITELIST,
// not "anything not pdf/docx": readAsText NEVER throws on binary input — it silently produces
// replacement-character mojibake — so a file that is neither a document (pdf/docx, extracted
// server-side) nor recognised text must be REFUSED with a typed "couldn't read" banner, not decoded
// as garbage and attached as if it were content (the "every outcome is a typed result, never a guess"
// invariant). A legacy binary `.doc` (application/msword) matches nothing here and is refused, not
// mojibake'd. Extension OR a text/* MIME — the extension leads because `accept` is only a picker hint.
const TEXT_ATTACH_EXTS = [
  "txt", "text", "md", "markdown", "eml", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml", "log",
];
export function isTextAttachable(fileName: string, mime?: string): boolean {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (ext && TEXT_ATTACH_EXTS.includes(ext)) return true;
  // A text/* MIME with no (or an unknown) extension is still text — but application/msword etc. are not.
  return typeof mime === "string" && mime.startsWith("text/");
}

