import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/site-url";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantAlertEmail, isDeliverableEmail } from "@/lib/email/send";
import { loadAlertContext, alertRecipient, type AlertContext } from "@/lib/alerts/generate";
import {
  getOrCreateDraftAlert,
  loadAlertPdf,
  findSentAlert,
  claimAlertForSend,
  releaseAlertClaim,
  type GrantAlertRow,
} from "@/lib/alerts/store";
import {
  recordClientDecision,
  finalizeClientCardSent,
  prospectConvertForSend,
  finalizeProspectSent,
  finalizeLeadSent,
  type ReOutreach,
} from "@/lib/alerts/send-core";
import { buildProspectEmailBody } from "@/lib/alerts/data";
import { senderFirstName } from "@/lib/alerts/sender";
import { computeGrantSummary } from "@/lib/review/summary";
import type { Prospect } from "@/types/database";

// Confirm-send for the grant alert -- the SINGLE send path. Reuses the SAVED
// draft (PDF + data), never re-renders, so what the admin reviewed is byte-for-
// byte what goes out. Two shapes by card type:
//   - CLIENT card: sending is also the terminal approval. Records
//     decision='approved' (through the admin-only trigger, via the user client)
//     and returns grant_summary so DecisionConfirmation fires. The decision is
//     recorded even when the email is blocked/unsent (mirrors the prior approve).
//   - PROSPECT card: sending promotes the prospect into a tracked lead
//     (convert-and-send, reusing lib/prospects/convert) and emails the one-pager.
//     No decision write (prospect approval would pollute client dashboards).
//     Convert + send are ATOMIC on a real send only: on preview / disabled /
//     allowlist-blocked, nothing converts and nothing is marked sent.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { cardId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role, full_name, email").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const ctx = await loadAlertContext(params.cardId);
  if (!ctx) return NextResponse.json({ error: "Card or grant not found" }, { status: 404 });

  // Guard 1 -- a sent card stays sent. If this card already has a delivered
  // alert, refuse BEFORE (re)generating a draft or emailing, so the
  // Regenerate->Send path can't cold-email a client/prospect a second time.
  const priorSent = await findSentAlert(params.cardId);
  if (priorSent) {
    const on = priorSent.sent_at
      ? ` on ${new Date(priorSent.sent_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`
      : "";
    return NextResponse.json({
      sent: false,
      alreadySent: true,
      send_status: `Already sent to ${priorSent.sent_to ?? "the recipient"}${on} — not re-sent.`,
    });
  }

  const input = (await req.json().catch(() => ({}))) as {
    to?: string;
    subject?: string;
    body?: string;
    reOutreach?: string;
  };
  const origin = appBaseUrl(req);
  // A cold re-contact's chosen variant (recorded on the grant_alert_sent event so the
  // sales workflow can see re-contact frequency + path). Only the two known values;
  // anything else -> undefined (a first-contact send writes no metadata key). Never
  // applies to a warm client send (clientSend takes no reOutreach).
  const reOutreach: ReOutreach | undefined =
    input.reOutreach === "acknowledged" || input.reOutreach === "follow_up" ? input.reOutreach : undefined;

  let alert: GrantAlertRow;
  try {
    alert = await getOrCreateDraftAlert(ctx, user.id, origin);
  } catch (err) {
    return NextResponse.json(
      { error: `Draft not ready: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const recipient = (input.to ?? alertRecipient(ctx).email).trim();
  const subject = (input.subject ?? "").trim() || alert.subject || `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`;
  let emailBody = (input.body ?? "").trim() || alert.email_body || "";

  // Re-resolve the cold intro's sender name when a DIFFERENT admin is sending than
  // the one who drafted it. The saved body carries the draft creator's name, and the
  // modal posts that saved body back verbatim on an as-is send -- so only rebuild
  // when the posted body is UNEDITED (== the saved body), to never clobber a
  // hand-edited note. Cold-body cards only (a discovery prospect OR a lead); the PDF
  // has no sender name, so it and the baked scheduling link are untouched.
  if (
    (ctx.card.card_type === "prospect" || ctx.isLead) &&
    alert.created_by !== user.id &&
    emailBody === (alert.email_body ?? "").trim()
  ) {
    emailBody = buildProspectEmailBody(
      ctx.grant,
      ctx.card,
      senderFirstName({ full_name: profile.full_name, email: profile.email }),
      !!alert.alert_data?.schedulingUrl,
    );
  }

  // Three-way send fork, keyed on card_type FIRST then lead-status (deliberate
  // order; a card is never both -- a prospect card has no client row). A lead is an
  // unconverted client row (Tara-build manual prospect): cold pitch, no decision.
  if (ctx.card.card_type === "prospect") {
    return prospectSend({ ctx, alert, recipient, subject, emailBody, userId: user.id, reOutreach });
  }
  if (ctx.isLead) {
    return leadSend({ ctx, alert, recipient, subject, emailBody, reOutreach });
  }
  return clientSend({ supabase, ctx, alert, recipient, subject, emailBody, userId: user.id, cardId: params.cardId });
}

// ── Prospect: convert-to-lead + send the one-pager, atomically, on a real send ──
async function prospectSend(a: {
  ctx: AlertContext;
  alert: GrantAlertRow;
  recipient: string;
  subject: string;
  emailBody: string;
  userId: string;
  reOutreach?: ReOutreach;
}) {
  const { ctx, alert, recipient, subject, emailBody, userId, reOutreach } = a;

  // Gate FIRST: no conversion, no send, no state change on preview / blocked.
  if (!isDeliverableEmail(recipient)) {
    return NextResponse.json({ sent: false, reason: "no deliverable email on file" });
  }
  const gate = canSendOutreach(recipient);
  if (!gate.ok) return NextResponse.json({ sent: false, reason: gate.reason });

  // Guard 2 -- atomic claim BEFORE any send-side effect (convert + email). If a
  // concurrent send already claimed this draft, refuse: no convert, no email.
  const claimed = await claimAlertForSend(alert.id, recipient);
  if (!claimed) {
    return NextResponse.json({
      sent: false,
      alreadySent: true,
      send_status: "Already sent — a concurrent send delivered this alert.",
    });
  }

  const db = createServiceClient();
  const { data: prospect } = await db
    .from("prospects")
    .select("*")
    .eq("id", ctx.card.prospect_id)
    .single<Prospect>();
  if (!prospect) {
    await releaseAlertClaim(alert.id);
    return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
  }

  // Sync the confirmed contact email + promote to a tracked lead (idempotent:
  // reuses an existing lead / client). Pre-email half -- see send-core.
  let conv;
  try {
    conv = await prospectConvertForSend(db, { prospect, grantId: ctx.grant.id, userId, recipient });
  } catch (err) {
    await releaseAlertClaim(alert.id);
    return NextResponse.json(
      { sent: false, error: `Convert failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Rare: the org is already an active client -> defer to route-to-account-manager
  // (start-outreach behavior), do NOT cold-email a prospect one-pager. Release the
  // claim so the (unsent) draft isn't left marked sent.
  if (conv.outcome === "routed_to_client") {
    await releaseAlertClaim(alert.id);
    return NextResponse.json({
      sent: false,
      outcome: conv.outcome,
      reason: `${conv.name} is already a client — routed to their account manager, no prospect alert sent.`,
    });
  }

  // The booking link lives in the attached PDF (baked at draft time), so the
  // email body is sent as-is -- no appended URL line.
  try {
    const pdf = await loadAlertPdf(alert);
    const result = await sendGrantAlertEmail({ to: recipient, subject, body: emailBody, pdf });
    await finalizeProspectSent(db, {
      alertId: alert.id,
      sentTo: result.to,
      subject,
      emailBody,
      conv,
      prospect,
      grantId: ctx.grant.id,
      reOutreach,
    });
    return NextResponse.json({ sent: true, to: result.to, outcome: conv.outcome, leadName: conv.name });
  } catch (err) {
    // Claimed but the email threw -> roll the draft back so it isn't stuck "sent"
    // with nothing delivered; the lead promotion is idempotent on retry.
    await releaseAlertClaim(alert.id);
    return NextResponse.json(
      { sent: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}

// ── Lead (Tara-build manual prospect): cold pitch; gate-first, NO decision ──
// A lead is an un-converted client row matched against the full pool like a client,
// but sent COLD (booking link in the PDF, sender-named intro). It never records a
// decision (not a serviced client) and never converts (already a lead). Gate-first
// like a prospect: nothing happens on preview / blocked.
async function leadSend(a: {
  ctx: AlertContext;
  alert: GrantAlertRow;
  recipient: string;
  subject: string;
  emailBody: string;
  reOutreach?: ReOutreach;
}) {
  const { ctx, alert, recipient, subject, emailBody, reOutreach } = a;
  if (!ctx.client) return NextResponse.json({ error: "Lead client not found" }, { status: 404 });

  // Gate FIRST: no state change on preview / blocked.
  if (!isDeliverableEmail(recipient)) {
    return NextResponse.json({ sent: false, reason: "no deliverable email on file" });
  }
  const gate = canSendOutreach(recipient);
  if (!gate.ok) return NextResponse.json({ sent: false, reason: gate.reason });

  // Guard 2 -- atomic claim BEFORE the email.
  const claimed = await claimAlertForSend(alert.id, recipient);
  if (!claimed) {
    return NextResponse.json({
      sent: false,
      alreadySent: true,
      send_status: "Already sent — a concurrent send delivered this alert.",
    });
  }

  const db = createServiceClient();
  try {
    const pdf = await loadAlertPdf(alert);
    const result = await sendGrantAlertEmail({ to: recipient, subject, body: emailBody, pdf });
    await finalizeLeadSent(db, {
      alertId: alert.id,
      sentTo: result.to,
      subject,
      emailBody,
      clientId: ctx.client.id,
      grantId: ctx.grant.id,
      clientName: ctx.client.name,
      reOutreach,
    });
    return NextResponse.json({ sent: true, to: result.to });
  } catch (err) {
    // Claimed but the email threw -> roll the draft back so it isn't stuck "sent"
    // with nothing delivered; retry re-sends. No decision to preserve.
    await releaseAlertClaim(alert.id);
    return NextResponse.json(
      { sent: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}

// ── Client: send the one-pager; sending is also the card's approval ──
async function clientSend(a: {
  supabase: ReturnType<typeof createClient>;
  ctx: AlertContext;
  alert: GrantAlertRow;
  recipient: string;
  subject: string;
  emailBody: string;
  userId: string;
  cardId: string;
}) {
  const { supabase, ctx, alert, recipient, subject, emailBody, userId, cardId } = a;

  // Record the terminal decision first (pre-everything half -- see send-core), via
  // the USER client so the admin-only approval trigger validates. The decision
  // stands even if the send is later blocked/unsent.
  const decision = await recordClientDecision(supabase, cardId, userId, emailBody);
  if (!decision.ok) {
    const isApprovalBlock = decision.reason === "approval_forbidden";
    return NextResponse.json(
      { error: isApprovalBlock ? "Only admins can approve a match for client delivery" : "Failed to record decision" },
      { status: isApprovalBlock ? 403 : 500 },
    );
  }

  let sent = false;
  let send_status: string;
  let reason: string | undefined;
  if (!isDeliverableEmail(recipient)) {
    send_status = "approved — no deliverable email, alert not sent";
    reason = "no deliverable email on file";
  } else {
    const gate = canSendOutreach(recipient);
    if (!gate.ok) {
      send_status = `approved, alert not sent (${gate.reason})`;
      reason = gate.reason;
    } else {
      // Guard 2 -- atomic claim BEFORE the email. A concurrent send that already
      // claimed this draft loses here (0 rows) and must not re-email. The decision
      // is already recorded 'approved' above, so just refuse the duplicate send.
      const claimed = await claimAlertForSend(alert.id, recipient);
      if (!claimed) {
        return NextResponse.json({
          sent: false,
          alreadySent: true,
          send_status: "Already sent — a concurrent send delivered this alert.",
        });
      }
      try {
        const pdf = await loadAlertPdf(alert);
        const result = await sendGrantAlertEmail({ to: recipient, subject, body: emailBody, pdf });
        await finalizeClientCardSent(supabase, cardId, alert.id, result.to, subject, emailBody);
        sent = true;
        send_status = `alert sent to ${result.to}`;
      } catch (err) {
        // Claimed but the email threw -> roll the draft back so it isn't stuck
        // "sent" with nothing delivered; the approval stands, retry re-sends.
        await releaseAlertClaim(alert.id);
        send_status = `approved, alert NOT sent: ${err instanceof Error ? err.message : String(err)}`;
        reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const grant_summary = await computeGrantSummary(supabase, {
    card_type: ctx.card.card_type,
    grant_id: ctx.card.grant_id,
  });

  return NextResponse.json({ sent, to: sent ? recipient : undefined, reason, send_status, grant_summary });
}
