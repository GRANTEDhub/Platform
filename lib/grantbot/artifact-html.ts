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
export function artifactFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "document"}.html`;
}

// Wrap a sanitised HTML body into a self-contained document for download/standalone viewing. The body
// must already be DOCUMENT-sanitised; this only frames it. escapeHtml is applied to the <title> only.
export function artifactStandaloneHtml(title: string, sanitizedBodyHtml: string): string {
  const safeTitle = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    `<style>body{margin:0;background:#fff;}.gb-doc{max-width:800px;margin:40px auto;padding:0 24px;}${ARTIFACT_DOCUMENT_CSS}</style>`,
    "</head><body>",
    `<div class="gb-doc">${sanitizedBodyHtml}</div>`,
    "</body></html>",
  ].join("\n");
}
