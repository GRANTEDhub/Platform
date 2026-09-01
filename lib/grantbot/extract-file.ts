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
  | "docx_no_text" // the .docx parsed but yielded no text
  | "docx_too_large" // the .docx's DECOMPRESSED content exceeds the safe cap (zip-bomb guard)
  | "pdf_form_unreadable"; // an XFA/LiveCycle form whose page layer is Adobe's placeholder and whose data layer could not be extracted

// A .docx is a ZIP. The 5MB input cap bounds the COMPRESSED bytes; it does NOT bound what they inflate
// to, and mammoth (via JSZip) decompresses the whole archive into memory before the char cap ever
// runs — so a crafted <5MB zip-bomb could expand to gigabytes and OOM/hang the route. Cap the summed
// DECLARED uncompressed size of the archive's entries (read from the ZIP central directory, no
// decompression) before handing bytes to mammoth. Generous for a real text document; a text .docx is
// nowhere near this even with embedded media (which extractRawText ignores anyway).
export const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

// Sum the declared uncompressed sizes across a ZIP's central-directory entries, WITHOUT decompressing.
// Returns null if the bytes are not a parseable ZIP (→ not a valid .docx). A ZIP64 size marker
// (0xFFFFFFFF) yields Infinity — treated as over any sane cap, since a real .docx entry is never ≥4GB.
export function sumZipUncompressedSize(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  // The End Of Central Directory record sits near the end but can carry a trailing comment, so scan
  // back for its signature (bounded to the max comment length + the 22-byte record).
  const minStart = Math.max(0, bytes.byteLength - (0xffff + 22));
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true); // offset of the central directory
  if (off === 0xffffffff) return Number.POSITIVE_INFINITY; // ZIP64
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.byteLength || view.getUint32(off, true) !== CDH_SIG) return null;
    const uncompressed = view.getUint32(off + 24, true);
    if (uncompressed === 0xffffffff) return Number.POSITIVE_INFINITY; // ZIP64 entry
    total += uncompressed;
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

export type ExtractResult =
  | { ok: true; text: string; truncated: boolean; kind: "pdf" | "docx" }
  | { ok: false; reason: ExtractReason; detail?: string };

// Injectable seams (defaults are the real parsers) so the branch/typed-reason/cap logic is tested
// without shipping a binary fixture — the same pattern fetch.ts uses for its PdfExtract.
export type PdfExtract = (bytes: Uint8Array) => Promise<string>;
export type DocxExtract = (bytes: Uint8Array) => Promise<string>;
// XFA/LiveCycle form data-layer extraction: returns the form's text, or null when the PDF has no
// usable XFA datasets. Never throws to the caller (a pdf-lib error is caught → null).
export type XfaExtract = (bytes: Uint8Array) => Promise<string | null>;

// Page cap for pdf-parse. A "PDF bomb" (many pages, or streams that inflate hugely) can stay under the
// 5MB COMPRESSED input cap yet blow memory during parse. pdfjs honors `max` (it stops after N pages),
// which bounds the common page-explosion shape; a real NOFO/application form is a handful of pages, so
// 50 is generous. (A single-page stream-inflation bomb is not page-bounded and pdfjs cannot be aborted
// mid-parse — the fetch.ts limitation — so that residual is bounded only by the route's 60s maxDuration
// and Vercel's PER-INVOCATION memory isolation: a bomb kills one function instance, not the platform.)
const MAX_PDF_PAGES = 50;

const defaultPdfExtract: PdfExtract = async (bytes) => {
  // Import the LIB entry, not the package index: pdf-parse's index.js runs a debug-mode fixture read
  // when `module.parent` is falsy (as in a bundled serverless build), which throws ENOENT. The lib
  // entry is the bare async function with no such side effect — the same import fetch.ts uses.
  // @ts-expect-error -- pdf-parse ships no declaration for its /lib subpath entry
  const mod = (await import("pdf-parse/lib/pdf-parse.js")) as {
    default: (data: Buffer, options?: { max?: number }) => Promise<{ text: string }>;
  };
  const parsed = await mod.default(Buffer.from(bytes), { max: MAX_PDF_PAGES });
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

// ── XFA / LiveCycle form PDFs ────────────────────────────────────────────────────────────────────
//
// An XFA (dynamic form) PDF — the format of the federal SF-424 family and most agency application
// packages — carries NO real text in its page content stream. That stream holds only Adobe's
// "Please wait… if this message is not eventually replaced… upgrade your reader" PLACEHOLDER, so
// pdf-parse returns exactly that boilerplate. The real content lives in the AcroForm's `/XFA` packets
// (an array of name/stream pairs): `datasets` holds the filled field values (and, in the FTA/LiveCycle
// convention, their captions as sibling `lbl_hidden_*` fields). pdf-lib (already a dependency) reads
// those packets without a new dep; we decode `datasets` and flatten its leaf text.

// Detect Adobe's XFA render-fallback placeholder — the string pdf-parse returns for a dynamic form.
// This both TRIGGERS the XFA path and is the safety net: if XFA extraction then finds nothing, the
// result is a typed failure, never this boilerplate handed to the model as if it were the document.
export function looksLikeAdobeXfaFallback(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("please wait") &&
    (t.includes("if this message is not eventually replaced") ||
      t.includes("your pdf viewer may not be able to display"))
  );
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e[0] === "#") {
      const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

// Flatten an XFA `datasets` XML packet to text: the trimmed text of every LEAF element (one whose
// content has no nested element), one per line, entities decoded. Because the datasets carry both the
// filled values AND their `lbl_hidden_*` caption siblings, the output reads as interleaved
// label/value lines — enough for the model to read a filled form. Empty structural nodes (dataGroups,
// focus markers) have no text and are skipped. Deliberately a lightweight leaf extractor, not a full
// XML parse: no new dependency, and robust to the (schema-varying) datasets shape.
export function xfaDatasetsToText(datasetsXml: string): string {
  const re = /<([\w.:-]+)[^>]*>([^<]*)<\/\1\s*>/g;
  const lines: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(datasetsXml))) {
    const val = decodeXmlEntities(m[2]).replace(/\s+/g, " ").trim();
    if (val) lines.push(val);
  }
  return lines.join("\n");
}

const defaultXfaExtract: XfaExtract = async (bytes) => {
  const { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!acro || !("lookup" in acro)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xfa = (acro as any).lookup(PDFName.of("XFA"));
  if (!xfa) return null;

  const streamText = (s: unknown): string => {
    try {
      if (s instanceof PDFRawStream || s instanceof PDFStream) {
        return Buffer.from(decodePDFRawStream(s as import("pdf-lib").PDFRawStream).decode()).toString("utf8");
      }
    } catch {
      /* undecodable stream — treated as no datasets */
    }
    return "";
  };

  // Locate the `datasets` packet. Array form (the standard): alternating (name, stream) pairs — find
  // the pair whose NAME contains "datasets". Single-stream form: the whole XDP — slice out its
  // <xfa:datasets>…</xfa:datasets> block.
  let datasetsXml = "";
  if (xfa instanceof PDFArray) {
    const n = xfa.size();
    for (let i = 0; i + 1 < n; i += 2) {
      const name = xfa.lookup(i);
      if (name && name.toString().includes("datasets")) {
        datasetsXml = streamText(xfa.lookup(i + 1));
        break;
      }
    }
  } else {
    const whole = streamText(xfa);
    const match = whole.match(/<xfa:datasets[\s\S]*?<\/xfa:datasets\s*>/);
    if (match) datasetsXml = match[0];
  }
  if (!datasetsXml) return null;
  const text = xfaDatasetsToText(datasetsXml);
  return text.trim() ? text : null;
};

export interface ExtractOptions {
  mime?: string;
  pdfExtract?: PdfExtract;
  docxExtract?: DocxExtract;
  xfaExtract?: XfaExtract; // seam for the XFA form data-layer extractor (default defaultXfaExtract)
  // Seam for the zip-bomb pre-check (default sumZipUncompressedSize) — injectable so the guard's
  // branch logic is tested without crafting a real bomb.
  docxSize?: (bytes: Uint8Array) => number | null;
  maxBytes?: number;
  maxChars?: number;
  maxDocxUncompressed?: number;
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
    // First the page text layer (pdf-parse). For a normal PDF this is the content; for an XFA form it
    // is only Adobe's "please wait…" placeholder, and a scanned PDF yields nothing.
    let pageText = "";
    let parseError: string | null = null;
    try {
      pageText = await (opts.pdfExtract ?? defaultPdfExtract)(bytes);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    const isFallback = looksLikeAdobeXfaFallback(pageText);

    if (pageText.trim() && !isFallback) {
      raw = pageText; // real page content
    } else {
      // Adobe XFA placeholder, empty, or a parse failure → try the XFA data layer (a filled SF-424 /
      // agency form). tryXfa never throws; a pdf-lib error becomes null.
      let xfaText: string | null = null;
      try {
        xfaText = await (opts.xfaExtract ?? defaultXfaExtract)(bytes);
      } catch {
        xfaText = null;
      }
      if (xfaText && xfaText.trim()) {
        raw = xfaText;
      } else if (isFallback) {
        // An XFA form we could not read — NEVER return Adobe's placeholder as if it were the document.
        return {
          ok: false,
          reason: "pdf_form_unreadable",
          detail: "XFA/LiveCycle form: the page layer is Adobe's placeholder and the data layer could not be extracted",
        };
      } else if (parseError !== null) {
        return { ok: false, reason: "pdf_parse_failed", detail: parseError };
      } else {
        return { ok: false, reason: "pdf_no_text", detail: "no extractable text layer (likely a scanned PDF)" };
      }
    }
  } else {
    // Zip-bomb guard: bound the DECLARED uncompressed size before mammoth decompresses the archive
    // into memory (the 5MB input cap only bounds the compressed bytes). Not a parseable zip → it is
    // not a real .docx.
    const uncompressed = (opts.docxSize ?? sumZipUncompressedSize)(bytes);
    if (uncompressed === null) {
      return { ok: false, reason: "docx_parse_failed", detail: "not a valid .docx (zip) file" };
    }
    const docxCap = opts.maxDocxUncompressed ?? MAX_DOCX_UNCOMPRESSED_BYTES;
    if (uncompressed > docxCap) {
      return {
        ok: false,
        reason: "docx_too_large",
        detail: `decompressed content exceeds the safe limit (${Math.round(docxCap / (1024 * 1024))}MB)`,
      };
    }
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
