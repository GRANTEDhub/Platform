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
import type { ReviewCard, Client } from "@/types/database";

// Sends from the verified Resend domain (send.grantedco.com). Replies are
// directed to a monitored human inbox so the conversation happens over email
// (Phase 1). Both overridable by env; defaults are the verified addresses.
const FROM = process.env.EMAIL_FROM || "alerts@send.grantedco.com";
const REPLY_TO = process.env.EMAIL_REPLY_TO || "support@grantedco.com";
const SUBJECT = "Grant Alert! | GRANTED";

// Deliberately permissive format check -- catches null/"unknown"/obviously
// malformed addresses (a real share of the loaded roster has "unknown"), not a
// full RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SentResult {
  to: string;
  subject: string;
  id: string | null;
}

export async function sendAlertEmail(card: ReviewCard, client: Client): Promise<SentResult> {
  const to = (client.primary_contact_email ?? "").trim();
  if (!to || to.toLowerCase() === "unknown" || !EMAIL_RE.test(to)) {
    throw new Error(
      `No deliverable email for ${client.name}: "${client.primary_contact_email ?? "(null)"}"`,
    );
  }

  const body = card.final_outreach_email;
  if (!body || !body.trim()) {
    throw new Error(`No approved email body to send for ${client.name}`);
  }

  // Reached only after canSendEmail() passed and the recipient validated above.
  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject: SUBJECT,
    text: body,
  });
  if (error) {
    throw new Error(`Resend send failed for ${client.name}: ${error.message}`);
  }

  return { to, subject: SUBJECT, id: data?.id ?? null };
}
