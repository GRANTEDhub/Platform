// Phase 1 alert send. Assembles the email and (eventually) hands it to Resend.
//
// Phase 1 = send from a real GRANTED address, replies land in the normal inbox.
// The body is the human-approved final_outreach_email (the engine drafts it,
// the admin approves/edits it) -- send does NOT re-assemble from template fields.
// Subject is fixed. The recipient is the client's primary contact.
//
// Callers MUST gate this behind canSendEmail() (lib/email/guard.ts). This
// function assumes it is allowed to send and only validates the payload.

import type { ReviewCard, Client } from "@/types/database";

const FROM = "support@grantedco.com";
const SUBJECT = "Grant Alert! | GRANTED";

// Deliberately permissive format check -- catches null/"unknown"/obviously
// malformed addresses (a real share of the loaded roster has "unknown"), not a
// full RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SentResult {
  to: string;
  subject: string;
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

  const payload = { from: FROM, to, subject: SUBJECT, text: body };

  // TODO(resend): wire the Resend SDK call here once RESEND_API_KEY and a
  // verified grantedco.com sending domain are available. This stub logs the
  // fully assembled payload so the shape is testable without the key. It must
  // be REPLACED with the real call -- do not leave it logging-only once the key
  // exists, or approvals will silently no-op in production.
  console.log("[email:TODO(resend)] would send:", JSON.stringify(payload));

  return { to, subject: SUBJECT };
}
