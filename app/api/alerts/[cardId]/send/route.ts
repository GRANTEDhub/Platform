import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantAlertEmail, isDeliverableEmail } from "@/lib/email/send";
import { loadAlertContext } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, loadAlertPdf, markAlertSent } from "@/lib/alerts/store";
import { computeGrantSummary } from "@/lib/review/summary";

// Confirm-send for the grant alert -- the SINGLE send path for client cards.
// Reuses the SAVED draft (PDF + data), never re-renders, so what the admin
// reviewed is byte-for-byte what goes out. This is also the terminal DECISION for
// the card: it records decision='approved' (through the admin-only approval
// trigger, via the user-scoped client) and returns the same grant_summary the
// plain-text approve did, so the Matches confirmation screen still fires.
//
// The decision is recorded regardless of whether the email physically sends --
// mirroring the prior approve-send: on preview / disabled / allowlist-blocked /
// no-deliverable-email, the decision stands and the send is reported as not sent
// (the alert row stays a draft so it can be sent later). A real send marks the
// alert row sent (immutable) and stamps sent_at/sent_to on the card.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { cardId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const ctx = await loadAlertContext(params.cardId);
  if (!ctx) return NextResponse.json({ error: "Card or grant not found" }, { status: 404 });

  const input = (await req.json().catch(() => ({}))) as { to?: string; subject?: string; body?: string };

  let alert;
  try {
    alert = await getOrCreateDraftAlert(ctx, user.id);
  } catch (err) {
    return NextResponse.json(
      { error: `Draft not ready: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const recipient = (input.to ?? ctx.client?.primary_contact_email ?? "").trim();
  const subject = (input.subject ?? "").trim() || alert.subject || `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`;
  const emailBody = (input.body ?? "").trim() || alert.email_body || "";

  // Record the terminal decision first, via the USER client so the admin-only
  // guard_card_approval trigger validates. The decision stands even if the send
  // is blocked/unsent below.
  const { error: decideErr } = await supabase
    .from("review_cards")
    .update({
      decision: "approved",
      decision_reason: null,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      final_outreach_email: emailBody,
    })
    .eq("id", params.cardId);
  if (decideErr) {
    const isApprovalBlock = decideErr.message?.toLowerCase().includes("approve");
    return NextResponse.json(
      { error: isApprovalBlock ? "Only admins can approve a match for client delivery" : "Failed to record decision" },
      { status: isApprovalBlock ? 403 : 500 },
    );
  }

  // Attempt the send. Any not-sent outcome leaves the decision recorded and the
  // alert row a draft (re-sendable), and is reported verbatim.
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
          .eq("id", params.cardId);
        sent = true;
        send_status = `alert sent to ${result.to}`;
      } catch (err) {
        send_status = `approved, alert NOT sent: ${err instanceof Error ? err.message : String(err)}`;
        reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Same confirmation summary as the plain-text approve (reads fresh sent_at).
  const grant_summary = await computeGrantSummary(supabase, {
    card_type: ctx.card.card_type,
    grant_id: ctx.card.grant_id,
  });

  return NextResponse.json({ sent, to: sent ? recipient : undefined, reason, send_status, grant_summary });
}
