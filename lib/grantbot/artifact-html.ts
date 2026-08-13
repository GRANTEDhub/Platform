// Shared presentation for a GrantBot document artifact -- PURE (no server-only, no I/O), so both the
// server export route and the client preview pane import the SAME document stylesheet. That is what
// keeps the in-panel preview looking like the downloaded HTML.
//
// PLAIN, not house-styled, by design. Brick 1a is a readable structured document; brand fidelity
// (the navy/orange/Baskerville chrome) is the future "Brander" build. The CSS here is neutral and
// self-contained -- no external fonts, no brand tokens -- so a downloaded .html renders anywhere.

export const ARTIFACT_DOCUMENT_CSS = `
.gb-doc { color: #1a1a1a; font-family: Georgia, "Times New Roman", serif; line-height: 1.55; font-size: 15px; }
.gb-doc h1, .gb-doc h2, .gb-doc h3, .gb-doc h4, .gb-doc h5, .gb-doc h6 { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.25; margin: 1.4em 0 0.5em; font-weight: 600; }
.gb-doc h1 { font-size: 1.7em; }
.gb-doc h2 { font-size: 1.35em; border-bottom: 1px solid #e2e2e2; padding-bottom: 0.2em; }
.gb-doc h3 { font-size: 1.15em; }
.gb-doc p { margin: 0.6em 0; }
.gb-doc ul, .gb-doc ol { margin: 0.6em 0; padding-left: 1.5em; }
.gb-doc li { margin: 0.25em 0; }
.gb-doc blockquote { margin: 0.8em 0; padding: 0.2em 0 0.2em 1em; border-left: 3px solid #cfcfcf; color: #444; }
.gb-doc a { color: #0b57d0; }
.gb-doc hr { border: 0; border-top: 1px solid #e2e2e2; margin: 1.4em 0; }
.gb-doc code, .gb-doc pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f4; }
.gb-doc pre { padding: 0.8em; overflow-x: auto; border-radius: 4px; }
.gb-doc table { border-collapse: collapse; width: 100%; margin: 0.9em 0; font-size: 0.95em; }
.gb-doc th, .gb-doc td { border: 1px solid #d6d6d6; padding: 6px 10px; text-align: left; vertical-align: top; }
.gb-doc th { background: #f4f4f4; font-weight: 600; }
.gb-doc caption { caption-side: top; font-size: 0.9em; color: #555; margin-bottom: 0.3em; text-align: left; }
`.trim();

// A URL/file-safe slug for a download filename, bounded and never empty.
function artifactSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document"
  );
}

// Download filename for a given export format. One source of truth so the .html download (1a) and the
// PDF/.docx downloads (1b) all slugify the title identically.
export function artifactExportFilename(title: string, format: "html" | "pdf" | "docx"): string {
  return `${artifactSlug(title)}.${format}`;
}

// Back-compat alias: the 1a HTML route imports this. Kept as the .html specialisation of the general
// helper above rather than a second slugifier.
export function artifactFilename(title: string): string {
  return artifactExportFilename(title, "html");
}

function escapeTitle(title: string): string {
  return title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// The outer HTML skeleton both document builders share. They differ ONLY in the <style> contents and
// (on-screen only) a viewport meta -- everything else is identical framing. Extracting it means a
// future change to the skeleton (the lang attr, an added meta, the wrapper div's class) applies to
// both formats at once, so the on-screen preview and the PDF/HTML export cannot silently drift -- the
// exact "preview == export" risk that the per-format duplication left uncovered.
function frameDocument(opts: { title: string; headExtras?: string; styleInner: string; body: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    opts.headExtras ?? "",
    `<title>${escapeTitle(opts.title)}</title>`,
    `<style>${opts.styleInner}</style>`,
    "</head><body>",
    `<div class="gb-doc">${opts.body}</div>`,
    "</body></html>",
  ]
    .filter(Boolean)
    .join("\n");
}

// Wrap a sanitised HTML body into a self-contained document for download/standalone viewing. The body
// must already be DOCUMENT-sanitised; this only frames it. escapeHtml is applied to the <title> only.
// Renders on the USER's browser (in-panel preview, .html download), so the neutral system font stacks
// in ARTIFACT_DOCUMENT_CSS resolve fine -- no embedded fonts needed here, unlike the PDF path.
export function artifactStandaloneHtml(title: string, sanitizedBodyHtml: string): string {
  return frameDocument({
    title,
    headExtras: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    styleInner: `body{margin:0;background:#fff;}.gb-doc{max-width:800px;margin:40px auto;padding:0 24px;}${ARTIFACT_DOCUMENT_CSS}`,
    body: sanitizedBodyHtml,
  });
}

// The PRINT framing for the PDF export (1b): same shared .gb-doc stylesheet, but the page geometry
// comes from @page (letter, ~0.9in margins) instead of the on-screen centred column -- so the PDF is
// a MULTI-PAGE letter document, not a screenshot of the panel. Headings avoid orphan breaks and
// tables/blockquotes/pre avoid splitting mid-block. Overrides sit AFTER the base CSS so they win.
//
// `fontFaceCss` carries embedded @font-face data-URIs -- REQUIRED for the PDF, because this HTML is
// rendered by SERVERLESS Chromium (via launchAlertBrowser), which has no gstatic egress and none of
// ARTIFACT_DOCUMENT_CSS's named system faces (Georgia/Arial/...) installed; without embedding, the
// PDF renders substitute fonts or tofu (the failure lib/alerts/render.ts's loadFontCss exists to
// prevent, and the locked "fonts embedded as @font-face data-URIs" invariant). The embedded families
// lead the font-family stacks below with the system names kept as fallbacks, so passing "" is a
// harmless no-op (the named faces are simply skipped) -- but the real caller always embeds.
export function artifactPrintHtml(title: string, sanitizedBodyHtml: string, fontFaceCss = ""): string {
  return frameDocument({
    title,
    styleInner: [
      fontFaceCss, // @font-face first, so the faces are declared before they're referenced
      "@page { size: letter; margin: 0.9in 0.85in; }",
      "html, body { margin: 0; background: #fff; }",
      ARTIFACT_DOCUMENT_CSS,
      // Print geometry + embedded-font preference + break control, after the base rules so they win.
      ".gb-doc { max-width: none; margin: 0; }",
      '.gb-doc { font-family: "Source Serif 4", Georgia, "Times New Roman", serif; }',
      '.gb-doc h1, .gb-doc h2, .gb-doc h3, .gb-doc h4, .gb-doc h5, .gb-doc h6 { font-family: "Inter Tight", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }',
      ".gb-doc h1, .gb-doc h2, .gb-doc h3, .gb-doc h4 { break-after: avoid; }",
      ".gb-doc table, .gb-doc pre, .gb-doc blockquote, .gb-doc tr { break-inside: avoid; }",
    ]
      .filter(Boolean)
      .join("\n"),
    body: sanitizedBodyHtml,
  });
}
