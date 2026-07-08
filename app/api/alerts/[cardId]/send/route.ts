import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/site-url";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantAlertEmail, isDeliverableEmail } from "@/lib/email/send";
import { loadAlertContext, alertRecipient, type AlertContext } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, loadAlertPdf, markAlertSent, type GrantAlertRow } from "@/lib/alerts/store";
import { buildProspectEmailBody } from "@/lib/alerts/data";
import { senderFirstName } from "@/lib/alerts/sender";
import { computeGrantSummary } from "@/lib/review/summary";
import { convertProspectToLead } from "@/lib/prospects/convert";
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

  const input = (await req.json().catch(() => ({}))) as { to?: string; subject?: string; body?: string };
  const origin = appBaseUrl(req);

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

  // Re-resolve the prospect intro's sender name when a DIFFERENT admin is sending
  // than the one who drafted it. The saved body carries the draft creator's name,
  // and the modal posts that saved body back verbatim on an as-is send -- so only
  // rebuild when the posted body is UNEDITED (== the saved body), to never clobber
  // a hand-edited note. Prospect-only; the PDF has no sender name, so it and the
  // baked scheduling link are untouched.
  if (
    ctx.card.card_type === "prospect" &&
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

  if (ctx.card.card_type === "prospect") {
    return prospectSend({ ctx, alert, recipient, subject, emailBody, userId: user.id });
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
}) {
  const { ctx, alert, recipient, subject, emailBody, userId } = a;

  // Gate FIRST: no conversion, no send, no state change on preview / blocked.
  if (!isDeliverableEmail(recipient)) {
    return NextResponse.json({ sent: false, reason: "no deliverable email on file" });
  }
  const gate = canSendOutreach(recipient);
  if (!gate.ok) return NextResponse.json({ sent: false, reason: gate.reason });

  const db = createServiceClient();
  const { data: prospect } = await db
    .from("prospects")
    .select("*")
    .eq("id", ctx.card.prospect_id)
    .single<Prospect>();
  if (!prospect) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  // Remember the confirmed contact email on the prospect (keeps it in sync with
  // what was actually sent, and available for the lead carry below).
  await db.from("prospects").update({ primary_contact_email: recipient }).eq("id", prospect.id);
  prospect.primary_contact_email = recipient;

  // Promote to a tracked lead (idempotent: reuses an existing lead / client).
  let conv;
  try {
    conv = await convertProspectToLead(db, {
      prospect,
      grantId: ctx.grant.id,
      userId,
      contactEmail: recipient,
      contactName: prospect.primary_contact_name,
      // No link token here -- the booking link is baked into the PDF at draft time
      // (prospect-scoped). This call is purely for pipeline tracking now.
      mintScheduleToken: false,
    });
  } catch (err) {
    return NextResponse.json(
      { sent: false, error: `Convert failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Rare: the org is already an active client -> defer to route-to-account-manager
  // (start-outreach behavior), do NOT cold-email a prospect one-pager.
  if (conv.outcome === "routed_to_client") {
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
    await markAlertSent(alert.id, { sentTo: result.to, subject, emailBody, clientId: conv.clientId });
    await db.from("pipeline_events").insert({
      event_type: "grant_alert_sent",
      client_id: conv.clientId,
      prospect_id: prospect.id,
      grant_id: ctx.grant.id,
      subject_snapshot: { name: prospect.name },
      metadata: { to: result.to },
    });
    return NextResponse.json({ sent: true, to: result.to, outcome: conv.outcome, leadName: conv.name });
  } catch (err) {
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

  // Record the terminal decision first, via the USER client so the admin-only
  // approval trigger validates. The decision stands even if the send is unsent.
  const { error: decideErr } = await supabase
    .from("review_cards")
    .update({
      decision: "approved",
      decision_reason: null,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      final_outreach_email: emailBody,
    })
    .eq("id", cardId);
  if (decideErr) {
    const isApprovalBlock = decideErr.message?.toLowerCase().includes("approve");
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
      try {
        const pdf = await loadAlertPdf(alert);
        const result = await sendGrantAlertEmail({ to: recipient, subject, body: emailBody, pdf });
        await markAlertSent(alert.id, { sentTo: result.to, subject, emailBody });
        await supabase
          .from("review_cards")
          .update({ sent_at: new Date().toISOString(), sent_to: result.to })
          .eq("id", cardId);
        sent = true;
        send_status = `alert sent to ${result.to}`;
      } catch (err) {
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
