// Plain text -> a minimal HTML body, so one editable draft can be sent as both parts of
// a multipart email and they can never disagree.
//
// THE TEXT IS THE SOURCE. The composer edits plain text; the HTML is DERIVED from
// whatever the sender finally typed. Authoring the two separately is how a hand-edit to
// the note ships in one part and not the other -- the same preview-==-sent discipline the
// alert PDF is built on, applied to the email body.
//
// DELIBERATELY MINIMAL. No layout, no images, no brand furniture, no external CSS: the
// point is a real anchor for the portal link instead of a raw URL, not a designed email.
// A templated HTML alert is its own piece of work.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Only http(s), and only a URL we built ourselves -- never one parsed out of the body.
// An href assembled from arbitrary text is how `javascript:` lands in a client's inbox.
function safeHref(url: string): string | null {
  const u = url.trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) return null;
  return escapeHtml(u);
}

export interface HtmlLink {
  // The exact line in the plain-text body to replace. Matched verbatim; if it is not
  // there (the sender deleted or edited it), the HTML simply carries no anchor and the
  // text part is unchanged -- no silent re-insertion of a link they took out.
  url: string;
  // What the anchor reads as. The grant name, usually.
  label: string;
}

export function plainTextToHtml(text: string, link?: HtmlLink): string {
  const href = link ? safeHref(link.url) : null;
  const label = link ? escapeHtml(link.label.trim() || link.url) : "";

  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => {
        // The URL line becomes the anchor. Compared on the TRIMMED line so leading
        // whitespace in the draft does not defeat the match.
        if (href && link && line.trim() === link.url.trim()) {
          return `<a href="${href}">${label}</a>`;
        }
        return escapeHtml(line);
      });
      // <br> inside a paragraph, not between paragraphs: a plain-text draft uses single
      // newlines for a wrapped address block or a label-then-value pair, and turning
      // those into paragraph breaks doubles the spacing the sender saw in the composer.
      return `<p style="margin:0 0 14px">${lines.join("<br>")}</p>`;
    });

  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0B1E3A">`,
    ...paragraphs,
    `</div>`,
  ].join("");
}
