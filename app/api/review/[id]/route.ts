import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendOutreachEmail, isDeliverableEmail } from "@/lib/email/send";
import type { CardDecision, Client } from "@/types/database";

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
    final_to?: string;
    final_subject?: string;
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
    try {
      const { data: client } = await supabase
        .from("clients")
        .select("*")
        .eq("id", data.client_id)
        .single<Client>();
      if (!client) throw new Error("client not found for card");

      // Recipient/subject/body come from the Send modal (editable in place),
      // falling back to the client's contact + the stored approved body. The
      // recipient the admin actually confirmed is what we gate + send to.
      const recipient = (body.final_to ?? client.primary_contact_email ?? "").trim();
      const emailBody = body.final_outreach_email ?? "";
      const subject = (body.final_subject ?? "").trim();

      // Combined gate: production+enabled+key (canSendEmail) AND the testing-mode
      // recipient allowlist (isRecipientAllowed) must both pass. Reported verbatim
      // so a blocked send is honest about WHY. The guard keys off VERCEL_ENV so a
      // preview deploy on this shared DB records the approval but cannot send.
      const gate = canSendOutreach(recipient);
      if (!gate.ok) {
        send_status = `decision recorded, email not sent (${gate.reason})`;
      } else if (!isDeliverableEmail(recipient)) {
        // No deliverable address on file / entered: skip the send gracefully.
        send_status = "decision recorded — no deliverable email, not sent";
      } else {
        // sendOutreachEmail hard-backstops the allowlist again, so no send path
        // can reach a real recipient without passing isRecipientAllowed.
        const sent = await sendOutreachEmail({
          to: recipient,
          subject,
          body: emailBody,
          contactName: client.primary_contact_name,
        });
        await supabase
          .from("review_cards")
          .update({ sent_at: new Date().toISOString(), sent_to: sent.to })
          .eq("id", params.id);
        send_status = `email sent to ${sent.to}`;
      }
    } catch (err) {
      send_status = `decision recorded, email NOT sent: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  // Post-decision summary for the Matches confirmation screen. Computed only for
  // a terminal decision on a CLIENT card (prospect cards keep the inline flow).
  // Read AFTER the send block so the just-approved card's sent_at is fresh.
  //   completed         -> zero remaining pending client cards on this grant
  //   prospect_eligible -> completed AND the grant would actually reach the
  //                        prospect feed (mirrors getProspectFeed's predicate:
  //                        domestic, no skip_reason, no hard_disqualifiers, not
  //                        Forecasted) -- so the "available for prospecting" line
  //                        is shown only when it is genuinely true.
  //   decided_results   -> per decided client: alerted (approved AND email sent,
  //                        i.e. sent_at set) vs recorded-not-sent vs rejected.
  let grant_summary: GrantSummary | null = null;
  if (isTerminal && data.card_type !== "prospect" && data.grant_id) {
    const { data: siblings } = await supabase
      .from("review_cards")
      .select("decision, sent_at, card_type, clients(name)")
      .eq("grant_id", data.grant_id);
    const clientCards = (siblings ?? []).filter(
      (c: SiblingCard) => c.card_type !== "prospect",
    );
    const remaining = clientCards.filter((c) => c.decision === "pending");
    const completed = remaining.length === 0;

    let prospect_eligible = false;
    if (completed) {
      const { data: g } = await supabase
        .from("grants")
        .select("is_domestic, skip_reason, hard_disqualifiers, grant_status")
        .eq("id", data.grant_id)
        .single();
      prospect_eligible =
        !!g &&
        g.is_domestic === true &&
        !g.skip_reason &&
        (g.hard_disqualifiers?.length ?? 0) === 0 &&
        g.grant_status !== "Forecasted";
    }

    grant_summary = {
      grant_id: data.grant_id,
      completed,
      prospect_eligible,
      remaining_pending: remaining
        .map((c) => siblingName(c))
        .filter((n): n is string => !!n),
      decided_results: clientCards
        .filter((c) => c.decision !== "pending")
        .map((c) => ({
          name: siblingName(c),
          decision: c.decision as "approved" | "passed",
          sent: !!c.sent_at,
        })),
    };
  }

  return NextResponse.json({ card: data, send_status, grant_summary });
}

// Supabase types a to-one embed as an array; normalize both shapes.
type SiblingCard = {
  decision: string;
  sent_at: string | null;
  card_type: string | null;
  clients: { name: string } | { name: string }[] | null;
};

function siblingName(c: SiblingCard): string | null {
  const cl = c.clients;
  if (!cl) return null;
  return Array.isArray(cl) ? cl[0]?.name ?? null : cl.name;
}

export type DecidedResult = {
  name: string | null;
  decision: "approved" | "passed";
  sent: boolean;
};

export type GrantSummary = {
  grant_id: string;
  completed: boolean;
  prospect_eligible: boolean;
  remaining_pending: string[];
  decided_results: DecidedResult[];
};
