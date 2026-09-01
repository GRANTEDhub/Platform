import { describe, it, expect } from "vitest";
import { extractFileText, type PdfExtract, type DocxExtract } from "./extract-file";
import { attachKindFor } from "./label";

// Deterministic — the real pdf-parse / mammoth are injected as seams, so the branch, typed-reason,
// cap, and truncation logic is proven without shipping a binary fixture (the same pattern fetch.ts
// uses for PdfExtract). The parsers themselves are trusted deps.

const bytes = (s = "abc") => new Uint8Array([...Buffer.from(s)]);
const pdf = (text: string): PdfExtract => async () => text;
const docx = (text: string): DocxExtract => async () => text;
const boom = (): PdfExtract & DocxExtract => async () => {
  throw new Error("kaboom");
};

describe("attachKindFor — which files route to the server extractor", () => {
  it("matches .pdf and .docx by extension or MIME; nothing else (legacy .doc excluded)", () => {
    expect(attachKindFor("nofo.pdf")).toBe("pdf");
    expect(attachKindFor("x", "application/pdf")).toBe("pdf");
    expect(attachKindFor("letter.DOCX")).toBe("docx");
    expect(attachKindFor("x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(attachKindFor("notes.txt")).toBeNull();
    expect(attachKindFor("old.doc")).toBeNull(); // legacy binary .doc is NOT OOXML
    expect(attachKindFor("photo.png", "image/png")).toBeNull();
  });
});

describe("extractFileText — PDF", () => {
  it("returns the extracted text (kind pdf, not truncated)", async () => {
    const r = await extractFileText(bytes(), "nofo.pdf", { pdfExtract: pdf("The program funds X.") });
    expect(r).toEqual({ ok: true, text: "The program funds X.", truncated: false, kind: "pdf" });
  });

  it("a PDF with no text layer (scanned) is a typed pdf_no_text — never a guess", async () => {
    const r = await extractFileText(bytes(), "scan.pdf", { pdfExtract: pdf("   ") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("pdf_no_text");
  });

  it("a PDF the parser can't read is a typed pdf_parse_failed with the error detail", async () => {
    const r = await extractFileText(bytes(), "broken.pdf", { pdfExtract: boom() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("pdf_parse_failed");
      expect(r.detail).toContain("kaboom");
    }
  });
});

describe("extractFileText — DOCX", () => {
  it("returns the extracted text (kind docx)", async () => {
    const r = await extractFileText(bytes(), "letter.docx", { docxExtract: docx("Dear reviewer,") });
    expect(r).toEqual({ ok: true, text: "Dear reviewer,", truncated: false, kind: "docx" });
  });

  it("an empty .docx is a typed docx_no_text", async () => {
    const r = await extractFileText(bytes(), "blank.docx", { docxExtract: docx("") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_no_text");
  });

  it("a .docx the parser can't read (or a renamed legacy .doc) is a typed docx_parse_failed", async () => {
    const r = await extractFileText(bytes(), "legacy.docx", { docxExtract: boom() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_parse_failed");
  });
});

describe("extractFileText — guards run BEFORE any parse (a throwing seam is never reached)", () => {
  it("zero bytes → empty", async () => {
    const r = await extractFileText(new Uint8Array(), "x.pdf", { pdfExtract: boom() });
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("over the byte cap → too_large", async () => {
    const r = await extractFileText(bytes("abcdef"), "x.pdf", { maxBytes: 3, pdfExtract: boom() });
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("not a .pdf or .docx → unsupported_type", async () => {
    const r = await extractFileText(bytes(), "photo.png", { mime: "image/png", pdfExtract: boom(), docxExtract: boom() });
    expect(r).toEqual({ ok: false, reason: "unsupported_type" });
  });
});

describe("extractFileText — truncation uses the shared cap", () => {
  it("caps long text and flags truncated", async () => {
    const r = await extractFileText(bytes(), "big.pdf", { maxChars: 5, pdfExtract: pdf("0123456789") });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("01234");
      expect(r.truncated).toBe(true);
    }
  });
});
