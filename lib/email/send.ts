// Phase 1 alert send. Assembles the email and (eventually) hands it to Resend.
//
// Phase 1 = send from a real GRANTED address, replies land in the normal inbox.
// The body is the human-approved final_outreach_email (the engine drafts it,
// the admin approves/edits it) -- send does NOT re-assemble from template fields.
// Subject is fixed. The recipient is the client's primary contact.
//
// Callers MUST gate this behind canSendEmail() (lib/email/guard.ts). This
// function assumes it is allowed to send and only validates the payload.

import { Resend } from "resend";
import { isRecipientAllowed } from "@/lib/email/guard";
import { sanitizeOutreachEmail } from "@/lib/email/sanitize";
import type { ReviewCard, Client } from "@/types/database";

// Sends from the verified Resend domain (send.grantedco.com). Replies are
// directed to a monitored human inbox so the conversation happens over email
// (Phase 1). Both overridable by env; defaults are the verified addresses.
const FROM = process.env.EMAIL_FROM || "alerts@send.grantedco.com";
const REPLY_TO = process.env.EMAIL_REPLY_TO || "support@grantedco.com";

// Subject convention: "GRANTED Alert! | <grant name>". Grants have no acronym
// field, so we do NOT invent one -- the full title is used, truncated at a word
// boundary when it runs long, to stay recognizable without being uselessly cut.
const SUBJECT_MAX_NAME = 50;
function subjectGrantName(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (!t) return "Grant Opportunity";
  if (t.length <= SUBJECT_MAX_NAME) return t;
  return t.slice(0, SUBJECT_MAX_NAME).replace(/\s+\S*$/, "").trim() + "…";
}

// Deliberately permissive format check -- catches null/"unknown"/obviously
// malformed addresses (a real share of the loaded roster has "unknown"), not a
// full RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Is this address safe to actually send to? Null / blank / "unknown" / malformed
// are NOT deliverable. Callers use this to SKIP the send gracefully (no throw)
// rather than attempt it. Doubles as a test-safety net: while the roster is
// mostly "unknown", only a client with a real email can receive an alert even
// when sending is globally enabled. Once real emails are filled in, this simply
// passes for everyone and every approve sends as intended.
export function isDeliverableEmail(email: string | null | undefined): boolean {
  const to = (email ?? "").trim();
  return !!to && to.toLowerCase() !== "unknown" && EMAIL_RE.test(to);
}

export interface SentResult {
  to: string;
  subject: string;
  id: string | null;
}

export async function sendAlertEmail(
  card: ReviewCard,
  client: Client,
  grantTitle: string | null,
): Promise<SentResult> {
  const to = (client.primary_contact_email ?? "").trim();
  // Backstop: callers should pre-check isDeliverableEmail and skip; if we're
  // called anyway with an undeliverable address, fail loud rather than send.
  if (!isDeliverableEmail(to)) {
    throw new Error(
      `No deliverable email for ${client.name}: "${client.primary_contact_email ?? "(null)"}"`,
    );
  }

  const body = card.final_outreach_email;
  if (!body || !body.trim()) {
    throw new Error(`No approved email body to send for ${client.name}`);
  }

  const subject = `GRANTED Alert! | ${subjectGrantName(grantTitle)}`;
  // Final deterministic cleanup at send time (covers drafts made before the
  // format rules landed, and any human edits): strip a "Subject:" line, resolve
  // a [Contact Name] to this recipient, drop a "[Your Name]" signature.
  const cleanBody = sanitizeOutreachEmail(body, client.primary_contact_name);

  // Reached only after canSendEmail() passed and the recipient validated above.
  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text: cleanBody,
  });
  if (error) {
    throw new Error(`Resend send failed for ${client.name}: ${error.message}`);
  }

  return { to, subject, id: data?.id ?? null };
}

// Warm-outreach send (lead pipeline). Same GRANTED identity and gating contract
// as the alert path (callers MUST pre-check canSendEmail); differs only in that
// the subject and body are the human-approved outreach draft, and the recipient
// is supplied explicitly (a grant-matched lead often has no email on file until
// the admin confirms one at send time).
export async function sendOutreachEmail(opts: {
  to: string;
  subject: string;
  body: string;
  contactName?: string | null;
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) {
    throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  }
  // Hard backstop for the testing-mode allowlist. Callers should pre-check via
  // canSendOutreach() and report the block cleanly; if a different send path
  // reaches here without that check, refuse rather than send to a real prospect.
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  if (!opts.body || !opts.body.trim()) throw new Error("Empty email body");
  const subject = (opts.subject ?? "").trim() || "A grant opportunity from GRANTED";
  const cleanBody = sanitizeOutreachEmail(opts.body, opts.contactName ?? null);

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text: cleanBody,
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}

// Sends the signed-contract PDF to the client as an attachment (their permanent
// copy). Same GRANTED identity/gating contract as the other sends: callers MUST
// pre-check canSendEmail(); the testing-mode allowlist is hard-backstopped here
// so a test signing never emails a real client. Attaching (not linking) keeps the
// legal PDF out of a shareable URL and gives the client a durable copy.
export async function sendContractCopyEmail(opts: {
  to: string;
  orgName: string;
  contactName?: string | null;
  pdf: Buffer;
  filename?: string;
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  const subject = `Your signed GRANTED agreement`;
  const greeting = opts.contactName ? `Hi ${opts.contactName},` : "Hello,";
  const text = [
    greeting,
    "",
    `Thank you for signing your engagement agreement with GRANTED. Your signed copy is attached for your records.`,
    "",
    "We'll be in touch with next steps shortly.",
    "",
    "— GRANTED",
  ].join("\n");

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text,
    attachments: [{ filename: opts.filename || "GRANTED-Agreement.pdf", content: opts.pdf }],
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}
