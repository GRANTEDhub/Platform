import { describe, it, expect } from "vitest";
import { extractFileText, sumZipUncompressedSize, type PdfExtract, type DocxExtract } from "./extract-file";
import { attachKindFor, isTextAttachable } from "./label";

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

describe("isTextAttachable — the client readAsText whitelist (never mojibake a binary)", () => {
  it("accepts genuinely-text extensions and text/* MIME", () => {
    for (const n of ["a.txt", "a.md", "thread.eml", "data.csv", "x.json", "page.html", "p.htm", "d.xml", "c.yaml", "l.log"]) {
      expect(isTextAttachable(n)).toBe(true);
    }
    expect(isTextAttachable("noext", "text/plain")).toBe(true);
  });

  it("REFUSES a legacy .doc and other binaries (they must not read as text)", () => {
    expect(isTextAttachable("resume.doc", "application/msword")).toBe(false);
    expect(isTextAttachable("photo.png", "image/png")).toBe(false);
    expect(isTextAttachable("form.pdf", "application/pdf")).toBe(false); // handled by the extractor, not readAsText
    expect(isTextAttachable("archive.zip")).toBe(false);
    expect(isTextAttachable("noext")).toBe(false); // unknown ext + no text MIME → refuse, don't guess
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
  // These test the extraction/no-text logic, so they inject a passing size check (the real zip guard
  // is exercised by the zip-bomb describe block); `bytes()` here is not a real zip.
  const okSize = { docxSize: () => 1000 };

  it("returns the extracted text (kind docx)", async () => {
    const r = await extractFileText(bytes(), "letter.docx", { ...okSize, docxExtract: docx("Dear reviewer,") });
    expect(r).toEqual({ ok: true, text: "Dear reviewer,", truncated: false, kind: "docx" });
  });

  it("an empty .docx is a typed docx_no_text", async () => {
    const r = await extractFileText(bytes(), "blank.docx", { ...okSize, docxExtract: docx("") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_no_text");
  });

  it("a .docx the parser can't read (or a renamed legacy .doc) is a typed docx_parse_failed", async () => {
    const r = await extractFileText(bytes(), "legacy.docx", { ...okSize, docxExtract: boom() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_parse_failed");
  });
});

describe("extractFileText — DOCX zip-bomb guard (bound decompressed size before parsing)", () => {
  const bomb = () => 200 * 1024 * 1024; // declares 200MB uncompressed

  it("refuses a .docx whose declared uncompressed size exceeds the cap → docx_too_large, parser never called", async () => {
    const r = await extractFileText(bytes(), "bomb.docx", { docxSize: bomb, docxExtract: boom() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_too_large");
  });

  it("bytes that are not a parseable zip → docx_parse_failed (not a real .docx)", async () => {
    const r = await extractFileText(bytes(), "fake.docx", { docxSize: () => null, docxExtract: boom() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("docx_parse_failed");
  });

  it("under the cap → proceeds to the parser", async () => {
    const r = await extractFileText(bytes(), "ok.docx", { docxSize: () => 1000, docxExtract: docx("Body text.") });
    expect(r).toEqual({ ok: true, text: "Body text.", truncated: false, kind: "docx" });
  });
});

describe("sumZipUncompressedSize — read the ZIP central directory without decompressing", () => {
  // A minimal valid ZIP: one central-directory header declaring `uncompressed`, then the EOCD.
  function miniZip(uncompressed: number): Uint8Array {
    const name = "a";
    const cdh = new Uint8Array(46 + name.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir header sig
    cv.setUint32(24, uncompressed >>> 0, true); // uncompressed size
    cv.setUint16(28, name.length, true); // file name length
    cdh.set([...Buffer.from(name)], 46);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // EOCD sig
    ev.setUint16(10, 1, true); // total entries
    ev.setUint32(16, 0, true); // central dir starts at offset 0
    const out = new Uint8Array(cdh.length + eocd.length);
    out.set(cdh, 0);
    out.set(eocd, cdh.length);
    return out;
  }

  it("sums the declared uncompressed sizes", () => {
    expect(sumZipUncompressedSize(miniZip(500))).toBe(500);
  });

  it("returns null for bytes that are not a zip", () => {
    expect(sumZipUncompressedSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sumZipUncompressedSize(new Uint8Array(40))).toBeNull(); // no EOCD signature anywhere
  });

  it("treats a ZIP64 size marker as over any cap", () => {
    expect(sumZipUncompressedSize(miniZip(0xffffffff))).toBe(Number.POSITIVE_INFINITY);
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
