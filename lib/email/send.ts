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
import { plainTextToHtml, type HtmlLink, type DecisionBox, type CtaButton } from "./html";

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
  // Derived from the SANITIZED body -- the same string that goes out as the text part --
  // so the two can never disagree.
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

  // A REAL BUTTON for the one action this email exists to prompt. The setup link used to
  // arrive as a bare pasted URL, which is both unbranded and easy to mistake for something
  // to ignore -- and it is the single thing standing between a new client and their portal.
  //
  // DERIVED from the text above, not authored separately: the CTA names the URL line already
  // in `text`, so the two parts cannot drift, and if that line ever changes the button simply
  // does not appear rather than pointing somewhere the text does not mention. Same contract
  // the alert email's decision box uses.
  //
  // The raw URL is rendered under the button as well -- see renderCta. A setup link is
  // single-use and expiring, so a recipient whose client mangles the button markup must still
  // be able to see it rather than reply "the link didn't work" about something invisible.
  const html = plainTextToHtml(text, {
    cta: { url: opts.url.trim(), label: "Set up your account" } satisfies CtaButton,
  });

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({ from: FROM, to, replyTo: REPLY_TO, subject, text, html });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}

// ── Staff / contractor login invite ──────────────────────────────────────────
//
// Sent when an admin creates a login in /settings/users. Before this, nothing was
// emailed at all: the panel created the account and the temp password was only ever
// visible on the admin's own screen, so a login handed over by memory or a chat
// message was the actual onboarding path.
//
// IT CARRIES THE TEMP PASSWORD IN PLAIN TEXT, and that is a deliberate trade rather
// than an oversight. The alternative -- a set-password link and no password at all --
// is worse HERE specifically, because this app has no forgot-password page and no
// staff-facing password reset: a link that failed to arrive would leave an account
// nobody could enter. A temp password keeps the admin's screen as the fallback.
//
// The honest cost, written down because the copy in the UI used to hide it: "temp" is
// a misnomer until a staff reset flow exists. Until then this credential is permanent
// unless an admin rotates it in the Supabase dashboard, and the email is a lasting
// copy of it. A staff password-reset path is the fix, and it is the next brick, not a
// someday item.
//
// NOT AN OUTREACH SEND, but it still respects the allowlist. isRecipientAllowed is
// hard-backstopped here exactly as in every other function in this file: if
// OUTREACH_SEND_ALLOWLIST is set for testing, a staff invite is blocked too rather
// than quietly exempting itself from the one switch that makes previews safe.
export async function sendStaffInviteEmail(opts: {
  to: string;
  fullName?: string | null;
  tempPassword: string;
  loginUrl: string;
  role: "admin" | "contractor";
}): Promise<SentResult> {
  const to = (opts.to ?? "").trim();
  if (!isDeliverableEmail(to)) throw new Error(`No deliverable recipient: "${opts.to ?? "(null)"}"`);
  if (!isRecipientAllowed(to)) {
    throw new Error(`Recipient not on send allowlist (testing mode): ${to}`);
  }
  if (!opts.tempPassword) throw new Error("No temporary password to send");
  if (!opts.loginUrl?.trim()) throw new Error("No login URL configured");

  const subject = "Your GRANTED platform login";
  const greeting = opts.fullName ? `Hi ${opts.fullName},` : "Hello,";
  const scope =
    opts.role === "admin"
      ? "You have full access."
      : "You have access to grant work — the review queue, the grant ledger, client profiles and proposal drafting. Invoicing, contracts and time tracking stay with the admins.";

  const text = [
    greeting,
    "",
    "Your login for the GRANTED platform is ready.",
    "",
    `Sign in:   ${opts.loginUrl.trim()}`,
    `Email:     ${to}`,
    `Password:  ${opts.tempPassword}`,
    "",
    scope,
    "",
    // States the real constraint instead of the reassuring version. There is no
    // self-serve change today, so promising one here would be the same false claim
    // the create form used to make.
    "This password can't be changed from inside the platform yet — if you want it changed, reply to this email and we'll rotate it for you.",
    "",
    "Best,",
    "GRANTED",
  ].join("\n");

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({ from: FROM, to, replyTo: REPLY_TO, subject, text });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return { to, subject, id: data?.id ?? null };
}
