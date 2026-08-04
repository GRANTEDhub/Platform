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

// The decision box: the one designed element in the email. Everything in it also
// exists in the text part -- grant name, deadline, the two URLs, the portal URL -- so
// this is a RENDERING of the text, never extra content only HTML readers get.
//
// The PDF stays the designed artifact. This is deliberately not a templated HTML
// alert: no images (so it survives image-blocking intact), no webfonts (Outlook
// ignores @font-face), no columns beyond the button table.
export interface DecisionBox {
  grantTitle: string;
  // Preformatted, e.g. "March 15, 2026". Null when the program has no dated deadline.
  deadline: string | null;
  interestedUrl: string;
  passUrl: string;
  // Where to read the full detail. Null when the client has no portal seat yet.
  portalUrl: string | null;
}

// A button, as email clients actually render one: a table cell carrying the fill and
// the padding, wrapping the anchor. A styled bare <a> is NOT a button in Outlook --
// it ignores padding on inline elements and you get coloured text.
function buttonCell(href: string, label: string, tone: "primary" | "quiet"): string {
  const bg = tone === "primary" ? "#B85A17" : "#FFFFFF";
  const fg = tone === "primary" ? "#FFFFFF" : "#4A5261";
  const border = tone === "primary" ? "#B85A17" : "#CFCAC0";
  return [
    `<td style="background-color:${bg};border:1px solid ${border};border-radius:2px;padding:0" bgcolor="${bg}">`,
    `<a href="${href}" style="display:inline-block;padding:10px 18px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:${fg};text-decoration:none">${label}</a>`,
    `</td>`,
  ].join("");
}

function renderBox(box: DecisionBox): string | null {
  const yes = safeHref(box.interestedUrl);
  const no = safeHref(box.passUrl);
  if (!yes || !no) return null;
  const portal = box.portalUrl ? safeHref(box.portalUrl) : null;

  // background-color AND color both set explicitly: dark mode in Apple Mail and
  // Outlook inverts an unset white surface and can leave navy text near-invisible.
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;border-collapse:separate">`,
    `<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #CFCAC0;border-radius:2px;padding:18px 20px">`,
    `<p style="margin:0 0 2px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6E7683">Your decision</p>`,
    `<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:700;line-height:1.35;color:#0B1E3A">${escapeHtml(box.grantTitle)}</p>`,
    // The deadline earns a line: without it "Interested" is a decision made with no
    // urgency attached, and it is the one fact that makes this time-sensitive.
    box.deadline
      ? `<p style="margin:6px 0 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#4A5261">Applications due <strong style="color:#0B1E3A">${escapeHtml(box.deadline)}</strong></p>`
      : "",
    `<p style="margin:6px 0 14px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#4A5261">The full one-pager is attached as a PDF.</p>`,
    // ASYMMETRIC ON PURPOSE. Equal weight would make this a 50/50 question, and it is
    // not: Interested should be effortless, passing should take a beat. It also matters
    // for thumbs -- two fat buttons side by side in a phone inbox get mis-tapped, and a
    // mis-tap on pass would quietly pull a grant out of their queue.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    buttonCell(yes, "Interested", "primary"),
    `<td style="width:10px">&nbsp;</td>`,
    buttonCell(no, "Not for us", "quiet"),
    `</tr></table>`,
    portal
      ? `<p style="margin:14px 0 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12.5px;color:#4A5261"><a href="${portal}" style="color:#8F4413;text-decoration:underline">Open it in your portal</a> to read the full detail first.</p>`
      : "",
    `</td></tr></table>`,
  ]
    .filter(Boolean)
    .join("");
}

export function plainTextToHtml(
  text: string,
  opts?: {
    // Bare URL lines to turn into labelled anchors. Was a single link; an array
    // because the decision block carries three.
    links?: HtmlLink[];
    // Rendered ABOVE the body when present. The caller is responsible for only
    // passing one whose URLs are actually in `text` (see bodyCarriesDecisionUrls) --
    // a box offering buttons the text part never mentions is the exact disagreement
    // between the two parts this module exists to prevent.
    box?: DecisionBox | null;
  },
): string {
  const links = (opts?.links ?? [])
    .map((l) => ({ href: safeHref(l.url), label: escapeHtml(l.label.trim() || l.url), url: l.url.trim() }))
    .filter((l): l is { href: string; label: string; url: string } => l.href !== null);

  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => {
        // The URL line becomes the anchor. Compared on the TRIMMED line so leading
        // whitespace in the draft does not defeat the match.
        const hit = links.find((l) => line.trim() === l.url);
        if (hit) return `<a href="${hit.href}">${hit.label}</a>`;
        return escapeHtml(line);
      });
      // <br> inside a paragraph, not between paragraphs: a plain-text draft uses single
      // newlines for a wrapped address block or a label-then-value pair, and turning
      // those into paragraph breaks doubles the spacing the sender saw in the composer.
      return `<p style="margin:0 0 14px">${lines.join("<br>")}</p>`;
    });

  const box = opts?.box ? renderBox(opts.box) : null;

  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0B1E3A">`,
    ...(box ? [box] : []),
    ...paragraphs,
    `</div>`,
  ].join("");
}
