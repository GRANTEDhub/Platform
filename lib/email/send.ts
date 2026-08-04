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
import { plainTextToHtml, type HtmlLink, type DecisionBox } from "./html";

// Sends from the verified Resend domain (send.grantedco.com). Replies are
// directed to a monitored human inbox so the conversation happens over email
// (Phase 1). Both overridable by env; defaults are the verified addresses.
// Sending ADDRESS is unchanged (alerts@send.grantedco.com, the verified domain);
// only the visible display name is set so inboxes show "GRANTED" rather than
// "alerts". If EMAIL_FROM already carries a display name ("Name <addr>"), respect it.
const FROM_ADDRESS = process.env.EMAIL_FROM || "alerts@send.grantedco.com";
const FROM = FROM_ADDRESS.includes("<") ? FROM_ADDRESS : `GRANTED <${FROM_ADDRESS}>`;
// Replies go to a monitored human inbox (NOT the unmonitored send address).
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
  // Set to send a multipart text+HTML email whose HTML is DERIVED HERE from the
  // sanitized text -- so the two parts cannot disagree, and a caller cannot accidentally
  // build the HTML from the pre-sanitize draft. The value is the anchor to substitute for
  // the bare URL line (see plainTextToHtml); pass it and you get HTML, omit it and the
  // email stays text-only exactly as before.
  htmlLink?: HtmlLink | null;
  // Optional attachments, same shape Resend takes. Used to hang the grant-alert one-pager
  // on a custom release note so the client can read it without signing in.
  attachments?: { filename: string; content: Buffer }[];
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
  const html = opts.htmlLink ? plainTextToHtml(cleanBody, { links: [opts.htmlLink] }) : undefined;
  const attachments = opts.attachments?.length ? opts.attachments : undefined;
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text: cleanBody,
    ...(html ? { html } : {}),
    ...(attachments ? { attachments } : {}),
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}

// Sends the discovery-call invite to a lead's contact: the engagement flyer
// attached + the scheduling link in the body, so the prospect books themselves.
// Same GRANTED identity/gating contract as the other sends -- callers MUST
// pre-check canSendOutreach(); the testing-mode allowlist is hard-backstopped
// here so a test invite never emails a real prospect. The flyer Buffer is read
// by the caller (route) from the traced asset and passed in, keeping this pure.
export async function sendDiscoveryInviteEmail(opts: {
  to: string;
  contactName?: string | null;
  schedulingUrl: string;
  flyer: Buffer;
  flyerFilename?: string;
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  if (!opts.schedulingUrl?.trim()) throw new Error("No scheduling link configured");

  const subject = "Let's find a time — GRANTED discovery call";
  const greeting = opts.contactName ? `Hi ${opts.contactName},` : "Hello,";
  const text = [
    greeting,
    "",
    "Thanks for your interest in working with GRANTED. We'd love to learn about your organization and where grant funding could help.",
    "",
    "Grab a time that works for you here:",
    opts.schedulingUrl.trim(),
    "",
    "I've attached a short overview of how we work. Looking forward to talking.",
    "",
    "Best,",
    "GRANTED",
  ].join("\n");

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text,
    attachments: [{ filename: opts.flyerFilename || "GRANTED-Overview.pdf", content: opts.flyer }],
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}

// Sends a grant-alert to the client: a SHORT text body + the branded one-page
// alert PDF attached. Same identity/gating contract as the other sends -- callers
// MUST pre-check canSendOutreach(); the testing-mode allowlist is hard-backstopped
// here so a test alert never reaches a real client. Subject/body are passed in
// (composed deterministically + human-reviewed in the preview modal).
export async function sendGrantAlertEmail(opts: {
  to: string;
  subject: string;
  body: string;
  pdf: Buffer;
  filename?: string;
  // Set to send multipart text+HTML with the decision box on top. The box's URLs must
  // already be in `body` -- the caller checks that (bodyCarriesDecisionUrls), because
  // the text is the source and a box offering buttons the text never mentions is the
  // two parts disagreeing. Omit it and the alert stays text-only exactly as before.
  decision?: DecisionBox | null;
  // Bare URL lines in `body` to render as labelled anchors in the HTML part.
  htmlLinks?: HtmlLink[];
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  const subject = opts.subject?.trim() || "A new grant was published";
  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  // Derived from the SAME body string that goes out as the text part, so a hand-edit in
  // the composer cannot ship in one part and not the other.
  const html = opts.decision ? plainTextToHtml(opts.body, { box: opts.decision, links: opts.htmlLinks }) : undefined;
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text: opts.body,
    ...(html ? { html } : {}),
    attachments: [{ filename: opts.filename || "GRANTED-Grant-Alert.pdf", content: opts.pdf }],
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}

// Notifies an account-managed client that their team has released a new grant
// match to their portal -- a lightweight transactional notice, NOT the PDF
// one-pager (that's sendGrantAlertEmail). Body = a short greeting + a deep link
// into the client's Grant Alerts view. Same GRANTED identity/gating contract as
// the other sends: callers MUST pre-check canSendOutreach(); the testing-mode
// allowlist is hard-backstopped here so a release notice never reaches a real
// client from a test deploy.
export async function sendGrantReleaseEmail(opts: {
  to: string;
  contactName?: string | null;
  grantTitle: string | null;
  url: string;
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  if (!opts.url?.trim()) throw new Error("No deep link configured");

  const subject = `New grant match ready to review | ${subjectGrantName(opts.grantTitle)}`;
  const greeting = opts.contactName ? `Hi ${opts.contactName},` : "Hello,";
  const text = [
    greeting,
    "",
    `Your GRANTED team has flagged a new grant match for you to review: ${opts.grantTitle?.trim() || "a new opportunity"}.`,
    "",
    "Take a look and let us know whether it's worth pursuing:",
    opts.url.trim(),
    "",
    "Best,",
    "GRANTED",
  ].join("\n");

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject,
    text,
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
    "Best,",
    "GRANTED",
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

// Welcomes a newly invited client and links them to set up their account (set a
// password, then review their profile). Lightweight text notice; the setup link
// is a one-time /auth/confirm link built in lib/clients/portal-login.ts. Same
// GRANTED identity/gating contract as the other senders -- callers MUST pre-check
// canSendOutreach(); the testing-mode allowlist is hard-backstopped here so a
// welcome never reaches a real inbox from a test deploy.
export async function sendClientInviteEmail(opts: {
  to: string;
  contactName?: string | null;
  orgName: string;
  url: string;
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  if (!opts.url?.trim()) throw new Error("No setup link configured");

  const subject = "Welcome to GRANTED — set up your account";
  const greeting = opts.contactName ? `Hi ${opts.contactName},` : "Hello,";
  const text = [
    greeting,
    "",
    `Welcome to GRANTED! We're glad to be starting the grant search for ${opts.orgName}.`,
    "",
    "Set up your account and confirm your organization's profile here:",
    opts.url.trim(),
    "",
    "That link signs you in and lets you set a password. If it has expired by the time you open it, reply to this email and we'll send a fresh one.",
    "",
    "Best,",
    "GRANTED",
  ].join("\n");

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({ from: FROM, to, replyTo: REPLY_TO, subject, text });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}
