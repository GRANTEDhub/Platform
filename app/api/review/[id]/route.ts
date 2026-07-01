import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canSendEmail } from "@/lib/email/guard";
import { sendAlertEmail } from "@/lib/email/send";
import type { CardDecision, ReviewCard, Client } from "@/types/database";

// Update a review-card decision. RLS + the guard_card_approval trigger enforce
// that only admins can set 'approved' (clear a match for client delivery);
// contractors may set 'passed' / 'pending'.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: {
    decision: CardDecision;
    decision_reason?: string;
    final_outreach_email?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const valid: CardDecision[] = ["pending", "approved", "passed"];
  if (!valid.includes(body.decision)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }

  const isTerminal = body.decision !== "pending";
  const update: Record<string, unknown> = {
    decision: body.decision,
    decision_reason:
      body.decision === "passed" ? body.decision_reason || null : null,
    decided_by: isTerminal ? user.id : null,
    decided_at: isTerminal ? new Date().toISOString() : null,
  };

  // On approval, persist the human-approved email body -- either edited, or the
  // AI draft copied as-is. Kept separate from draft_outreach_email so the
  // engine's original is never overwritten.
  if (
    body.decision === "approved" &&
    typeof body.final_outreach_email === "string"
  ) {
    update.final_outreach_email = body.final_outreach_email;
  }

  const { data, error } = await supabase
    .from("review_cards")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    // The approval trigger raises for non-admins trying to approve.
    const isApprovalBlock = error.message?.toLowerCase().includes("approve");
    return NextResponse.json(
      {
        error: isApprovalBlock
          ? "Only admins can approve a match for client delivery"
          : "Failed to update card",
      },
      { status: isApprovalBlock ? 403 : 500 },
    );
  }

  // Send step. Only an approval triggers a send. The guard keys off VERCEL_ENV
  // (see lib/email/guard.ts) so a preview deploy -- which reads this same shared
  // database -- records the approval but physically cannot send. A bad/"unknown"
  // recipient or a provider error is caught: the decision still stands, the send
  // is reported as not sent, and the status is surfaced to the UI (never silent).
  let send_status = "decision recorded";
  if (body.decision === "approved") {
    const gate = canSendEmail();
    if (!gate.ok) {
      send_status = `decision recorded, email not sent (${gate.reason})`;
    } else {
      try {
        const { data: client } = await supabase
          .from("clients")
          .select("*")
          .eq("id", data.client_id)
          .single<Client>();
        if (!client) throw new Error("client not found for card");
        const sent = await sendAlertEmail(data as ReviewCard, client);
        await supabase
          .from("review_cards")
          .update({ sent_at: new Date().toISOString(), sent_to: sent.to })
          .eq("id", params.id);
        send_status = `email sent to ${sent.to}`;
      } catch (err) {
        send_status = `decision recorded, email NOT sent: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  return NextResponse.json({ card: data, send_status });
}
