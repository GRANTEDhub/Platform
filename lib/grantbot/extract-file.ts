import { truncateSafely, attachKindFor, MAX_ATTACH_CHARS, MAX_ATTACH_BYTES } from "./label";

// Server-side text extraction for an UPLOADED binary document — PDF (pdf-parse) and .docx (mammoth).
//
// The client "Attach a file" action reads TEXT files itself (readAsText). A PDF/.docx read as text is
// garbage, and the parsers are node-only, so binaries are extracted HERE (behind /api/grantbot/extract)
// and the resulting TEXT is handed back to the client, which drops it into the SAME paste-attachment
// channel every other attachment uses. So the extracted text rides the exact same untrusted frame
// (framePastedContent) at turn time, under the same char cap (truncateSafely / MAX_ATTACH_CHARS) — no
// new trust surface, just a different way of turning a file into the text that gets framed.
//
// EVERY OUTCOME IS A TYPED RESULT, never a throw and never a GUESS — the same discipline as web-fetch's
// fetchGrantSource. A PDF that will not parse, or a scanned PDF with no text layer, or an empty .docx is
// a typed failure the UI relays ("couldn't read that file"), never an ok:true with an invented body. A
// scanned/image PDF is exactly the case the images-via-vision follow-on will cover; here it is honestly
// reported as "no text layer", not OCR-guessed.
//
// The bytes are never persisted — extraction is read-only and stateless; only the extracted text
// (which the staffer sees and can edit before sending) leaves this module.

export type ExtractReason =
  | "empty" // a zero-byte file
  | "too_large" // over MAX_ATTACH_BYTES — refused before parsing (the buffer is held whole in memory)
  | "unsupported_type" // not a .pdf or .docx (text files never reach this route; they read client-side)
  | "pdf_parse_failed" // pdf-parse could not read the bytes (corrupt / encrypted / not really a PDF)
  | "pdf_no_text" // the PDF parsed but has no text layer (a scanned image) — refuse to guess its content
  | "docx_parse_failed" // mammoth could not read the bytes (corrupt / not a real .docx / legacy .doc)
  | "docx_no_text"; // the .docx parsed but yielded no text

export type ExtractResult =
  | { ok: true; text: string; truncated: boolean; kind: "pdf" | "docx" }
  | { ok: false; reason: ExtractReason; detail?: string };

// Injectable seams (defaults are the real parsers) so the branch/typed-reason/cap logic is tested
// without shipping a binary fixture — the same pattern fetch.ts uses for its PdfExtract.
export type PdfExtract = (bytes: Uint8Array) => Promise<string>;
export type DocxExtract = (bytes: Uint8Array) => Promise<string>;

const defaultPdfExtract: PdfExtract = async (bytes) => {
  // Import the LIB entry, not the package index: pdf-parse's index.js runs a debug-mode fixture read
  // when `module.parent` is falsy (as in a bundled serverless build), which throws ENOENT. The lib
  // entry is the bare async function with no such side effect — the same import fetch.ts uses.
  // @ts-expect-error -- pdf-parse ships no declaration for its /lib subpath entry
  const mod = (await import("pdf-parse/lib/pdf-parse.js")) as {
    default: (data: Buffer, options?: unknown) => Promise<{ text: string }>;
  };
  const parsed = await mod.default(Buffer.from(bytes));
  return parsed.text ?? "";
};

const defaultDocxExtract: DocxExtract = async (bytes) => {
  const mammoth = await import("mammoth");
  // extractRawText → plain text (mammoth also does HTML, but the paste channel wants text, and the
  // untrusted frame is plain-text by design). mammoth reads .docx (OOXML) only; a legacy binary .doc
  // is not OOXML and will throw here → typed docx_parse_failed, never a guess.
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value ?? "";
};

export interface ExtractOptions {
  mime?: string;
  pdfExtract?: PdfExtract;
  docxExtract?: DocxExtract;
  maxBytes?: number;
  maxChars?: number;
}

export async function extractFileText(
  bytes: Uint8Array,
  fileName: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACH_BYTES;
  const maxChars = opts.maxChars ?? MAX_ATTACH_CHARS;

  if (bytes.length === 0) return { ok: false, reason: "empty" };
  // Refuse before parsing — the whole file is already buffered in memory to reach here, so this
  // bounds the parse work, not the upload (the client also guards, but the server is the guarantee).
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };

  const kind = attachKindFor(fileName, opts.mime);
  if (!kind) return { ok: false, reason: "unsupported_type" };

  let raw: string;
  if (kind === "pdf") {
    try {
      raw = await (opts.pdfExtract ?? defaultPdfExtract)(bytes);
    } catch (err) {
      return { ok: false, reason: "pdf_parse_failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (!raw.trim()) {
      return { ok: false, reason: "pdf_no_text", detail: "no extractable text layer (likely a scanned PDF)" };
    }
  } else {
    try {
      raw = await (opts.docxExtract ?? defaultDocxExtract)(bytes);
    } catch (err) {
      return { ok: false, reason: "docx_parse_failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (!raw.trim()) {
      return { ok: false, reason: "docx_no_text", detail: "the document had no extractable text" };
    }
  }

  // The ONE char cap, shared with the client text path and web-fetch (truncateSafely). The client
  // appends the "was truncated" note to the body when `truncated` — one note site, so it can't be
  // edited away in the label.
  const { text, truncated } = truncateSafely(raw, maxChars);
  return { ok: true, text, truncated, kind };
}
