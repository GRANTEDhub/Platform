// Deterministic cleanup of a drafted outreach email, so client-facing defects the
// drafting model sometimes emits never reach a recipient. Belt-and-suspenders with
// the generation-level prompt rules; idempotent, so it runs at BOTH draft time
// (the admin reviews clean text) and send time (covers older drafts + human edits).
//
//   - strips a leading "Subject: ..." line (the subject is set separately)
//   - resolves "[Contact Name]"-style placeholders to the real name (or a neutral
//     greeting when the name is unknown)
//   - removes a "[Your Name]" signature placeholder (no sender identity yet; the
//     sender adds their own signature)
//
// Em-dashes are intentionally handled at the generation level (prompt), not here --
// mechanically rewriting "—" would be lossy.
export function sanitizeOutreachEmail(
  body: string | null | undefined,
  contactName?: string | null,
): string {
  let s = (body ?? "").replace(/\r\n/g, "\n");

  // Strip a leading "Subject: ..." line + the blank line(s) after it.
  s = s.replace(/^\s*subject:.*\n+/i, "");

  // Contact-name placeholder -> the real name, or a neutral greeting when unknown.
  const name = (contactName ?? "").trim();
  const known = !!name && name.toLowerCase() !== "unknown";
  const nameToken = /\[\s*(?:contact\s*name|client\s*contact|recipient\s*name|name)\s*\]/gi;
  if (known) {
    s = s.replace(nameToken, name);
  } else {
    s = s.replace(
      /\bdear\s+\[\s*(?:contact\s*name|client\s*contact|recipient\s*name|name)\s*\]/gi,
      "Hello",
    );
    s = s.replace(nameToken, "there");
  }

  // Remove a signature-name placeholder; leave any closing line ("Best regards,").
  s = s.replace(/\[\s*your\s*name\s*\]/gi, "");

  // Collapse whitespace left behind (blank first line, trailing empty sign-off).
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
