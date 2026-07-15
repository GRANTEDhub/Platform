import "server-only";
import { PDFDocument } from "pdf-lib";

// Concatenate the saved per-grant alert PDFs into ONE multi-page document for an
// aggregate (multi-select) send -- copying each source's pages verbatim, never
// re-rendering. This preserves the save-once guarantee: page i of the merged PDF is
// byte-for-byte the one-page alert the single-send path produced (and the admin
// previewed) for grant i. Each source page carries its own embedded fonts and
// images, which copyPages brings across intact.
//
// Format-agnostic by design: it concatenates whatever each card rendered, so a
// differently-formatted alert (e.g. a future forecasted-grant template) merges here
// with no change.
export async function mergeAlertPdfs(pdfs: Buffer[]): Promise<Buffer> {
  if (pdfs.length === 0) {
    throw new Error("mergeAlertPdfs: no PDFs to merge");
  }
  // A single selection needs no re-encode -- return the exact bytes the single-send
  // path would have attached (byte-identical parity for a batch of one).
  if (pdfs.length === 1) return pdfs[0];

  const merged = await PDFDocument.create();
  for (const bytes of pdfs) {
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  const out = await merged.save();
  return Buffer.from(out);
}
