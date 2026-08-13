import "server-only";
import HTMLtoDOCX from "html-to-docx";
import { launchAlertBrowser } from "@/lib/alerts/render";
import { artifactPrintHtml } from "./artifact-html";

// The two rendered exports for a GrantBot document (Brick 1b). Both are PURE FUNCTIONS of the
// versioned, DOCUMENT-sanitised HTML -- given the same html+title they produce the same document, so
// the export cache (artifact-export.ts) can key on (artifact, version, format) and never has to
// invalidate: a new version is a new key.
//
// The HTML handed in here MUST already be sanitised (sanitizeDocument): no <style>/<script>/<img>,
// only the whitelisted structural tags. That is a precondition, not something re-checked here -- the
// one caller (the export scaffold) sanitises immediately before calling.

// PDF via the EXISTING Chromium launcher -- the same @sparticuz/chromium binary the grant alert uses,
// isolated to lib/alerts/render.ts. A thin wrapper: setContent -> page.pdf(). Deliberately NO
// pageRanges clamp (the alert pins pageRanges:"1" because it is one fixed letter page; a concept
// proposal is multi-page), and preferCSSPageSize honours the print stylesheet's @page letter size.
export async function renderArtifactPdf(sanitizedHtml: string, title: string): Promise<Buffer> {
  const html = artifactPrintHtml(title, sanitizedHtml);
  const browser = await launchAlertBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// Word (.docx) via html-to-docx: sanitised HTML -> REAL OOXML, not an .html renamed to .docx. The
// library maps semantic tags (h1-h6, p, ul/ol, table, strong/em, blockquote) to native Word styles,
// so headings and tables open as first-class Word objects. We pass a minimal document wrapper with
// the sanitised body; no <style>/<img> reaches it (stripped on sanitise), which is also why the
// image-size advisory in html-to-docx's tree is not reachable -- there are no images to parse.
export async function renderArtifactDocx(sanitizedHtml: string, title: string): Promise<Buffer> {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${sanitizedHtml}</body></html>`;
  const out = await HTMLtoDOCX(doc, null, {
    title,
    footer: false,
    pageNumber: false,
    table: { row: { cantSplit: true } },
  });
  // Node build returns a Buffer; normalise defensively in case a build hands back an ArrayBuffer.
  return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as ArrayBuffer);
}
