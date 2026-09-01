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

// ── PER-TURN IMAGE (vision) bounds, in the same client-safe place so the composer (grantbot-chat.tsx)
// and the server (vision.ts) enforce the SAME limits and cannot drift. An image is NOT extracted to
// text; it rides the turn as a base64 image content block the vision model reads directly, per turn,
// never stored.
//
// The cap is deliberately BELOW the file-attach cap (not MAX_ATTACH_BYTES): unlike a document, the image
// is NOT a multipart file — it rides the JSON turn body as base64, which inflates the raw bytes by ~4/3.
// Vercel's serverless request-body limit is ~4.5 MB, so a 5 MB image (~6.7 MB base64) would sail past a
// generous client check, attach, and then be rejected by the platform with an opaque 413 that surfaces
// as "Could not reach the server". 3 MB raw → ~4 MB base64, which fits under 4.5 MB even alongside the
// message text and a full pasted section — so the client's own typed "too large" refusal always fires
// first, and the turn body never 413s.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// A WHITELIST of image media types Claude vision accepts that we allow — PNG and JPEG cover every
// screenshot / snip / phone photo staff attach. Kept narrow on purpose: GIF/WebP are declined with a
// typed banner rather than sent and rejected by the API (the "never a guess" contract, on the image
// side). Extension is only a picker hint, so the MIME leads here.
export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

// Is this a paste/upload the composer should treat as a vision image (vs. route to text/doc extraction)?
// MIME only — an image on the clipboard has no filename, and a picked file's type is authoritative for
// png/jpeg. A .jpg with a wrong/blank MIME falls through to the doc/text paths, which refuse it typed.
// The compact marker appended to a user turn's stored text when an image rode it. TWO jobs, ONE string
// so the server and client can't drift: (1) a replay note for the model on a LATER turn — an image was
// here, and is no longer in view; (2) a token the transcript renderer detects and shows as a small
// "image" CHIP rather than as prose, so it never reads as if we rewrote the staffer's own words. Kept
// SHORT for both — the long sentence it replaced looked like an edit to the message.
export const IMAGE_ATTACHED_TAG = "[image attached — not retained]";

// Split the image tag off the END of a user turn's text so the transcript renders the staffer's actual
// words as prose and the "image attached" fact as a small chip — never as a sentence appended to what
// they typed. The tag sits on its own trailing "\n\n" segment (send() appends it last). Pure + here in
// the client-safe module so the renderer and any test share one definition.
export function splitImageTag(text: string): { body: string; hadImage: boolean } {
  const suffix = `\n\n${IMAGE_ATTACHED_TAG}`;
  if (text.endsWith(suffix)) return { body: text.slice(0, -suffix.length), hadImage: true };
  if (text === IMAGE_ATTACHED_TAG) return { body: "", hadImage: true };
  return { body: text, hadImage: false };
}

export function isAttachableImage(mime?: string): mime is ImageMime {
  return typeof mime === "string" && (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

