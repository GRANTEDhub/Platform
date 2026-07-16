import { formatDeadline } from "@/lib/grants/format";
import { PROSPECT_CREDENTIAL } from "./copy";
import type { Grant } from "@/types/database";

// Aggregate (multi-select) client alert email -- the cover note for a batch send.
// The attached PDF pages ARE the content (one per grant); this email is a short
// plain-text wrapper listing what's attached. Mirrors the single-send client body
// (buildAlertEmailBody): salutation, one lead-in, the grant list, a PDF pointer, a
// clean close. Plain text, middot separators, no em dashes, no over-promising
// (org rules).
//
// Forecasted-safe by construction: each line is built from null-tolerant fields --
// formatDeadline returns "—" when a deadline isn't on file, which we then OMIT (so
// the line never carries the em-dash sentinel and never asserts a deadline a
// forecasted grant doesn't have yet). No active-grant assumption anywhere here.

export type BatchGrant = Pick<Grant, "title" | "funder" | "submission_deadline">;

// One compact line per grant: "Title · Funder · deadline <date>", dropping any part
// that isn't on file. formatDeadline's "—" empty sentinel is treated as absent.
function grantLine(g: BatchGrant): string {
  const parts: string[] = [g.title?.trim() || "Untitled opportunity"];
  const funder = g.funder?.trim();
  if (funder) parts.push(funder);
  const deadline = formatDeadline(g.submission_deadline);
  if (deadline && deadline !== "—") parts.push(`deadline ${deadline}`);
  return `- ${parts.join(" · ")}`;
}

export function batchAlertSubject(grants: BatchGrant[]): string {
  const n = grants.length;
  return `GRANTED Alert! | ${n} new grant ${n === 1 ? "opportunity" : "opportunities"}`;
}

// Compose the aggregate client email. `grants` is the ordered set actually going
// out (the caller resolves it -- selected, claimed, one recipient); the count drives
// both the copy and the "N-page PDF" pointer so the email never mis-states how many
// pages are attached.
export function buildClientBatchEmail(grants: BatchGrant[]): { subject: string; body: string } {
  const n = grants.length;
  const lead =
    n === 1
      ? "A new opportunity came through that may be a fit:"
      : "A few new opportunities came through that may be a fit:";
  const pdfLine =
    n === 1
      ? "The full alert is attached as a one-page PDF."
      : `The full alerts are attached as a ${n}-page PDF, one page per grant.`;
  const body = [
    "Hello,",
    "",
    lead,
    "",
    ...grants.map(grantLine),
    "",
    pdfLine,
    "",
    "Best,",
    "GRANTED",
  ].join("\n");
  return { subject: batchAlertSubject(grants), body };
}

// Aggregate LEAD (Tara-build manual prospect) cold pitch -- a not-yet-client matched
// against the full pool like a client, but sent COLD to win their business. Mirrors
// the single-send cold body (buildProspectEmailBody) -- sender-named intro, the same
// verbatim credential block, a book-a-call CTA -- but for N grants (the compact list),
// not one. The attached merged PDF carries a /go booking link per page (minted at
// prepare time), so the CTA is always honest for a lead batch. `senderFirstName` is
// null-safe to a name-less intro (never an email as a name). Warm CLIENT batches use
// buildClientBatchEmail; this is never used for a client.
export function buildLeadBatchEmail(
  grants: BatchGrant[],
  senderFirstName: string | null,
): { subject: string; body: string } {
  const n = grants.length;
  const name = senderFirstName?.trim();
  const intro = name
    ? `I'm ${name} with GRANTED. A few grants look like strong fits for your organization and I wanted to flag them.`
    : `I'm reaching out from GRANTED. A few grants look like strong fits for your organization and I wanted to flag them.`;
  const pdfLine =
    n === 1
      ? "The full alert, including a link to schedule a call, is attached as a one-page PDF."
      : `The full alerts, including a link to schedule a call, are attached as a ${n}-page PDF, one page per grant.`;
  const body = [
    "Hello,",
    "",
    intro,
    "",
    ...grants.map(grantLine),
    "",
    PROSPECT_CREDENTIAL,
    "",
    pdfLine,
    "",
    "Best,",
    "GRANTED",
  ].join("\n");
  return { subject: batchAlertSubject(grants), body };
}
