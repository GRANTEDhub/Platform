import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CardDecision } from "@/types/database";

// Update a review-card decision. RLS + the guard_card_approval trigger enforce
// that only admins can set 'approved' (clear a match for client delivery);
// contractors may set 'passed' / 'hold' / 'pending'.
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
    hold_reason?: string;
    decision_reason?: string;
    final_outreach_email?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const valid: CardDecision[] = ["pending", "approved", "passed", "hold"];
  if (!valid.includes(body.decision)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }

  const isTerminal = body.decision !== "pending";
  const update: Record<string, unknown> = {
    decision: body.decision,
    hold_reason: body.decision === "hold" ? body.hold_reason || null : null,
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

  // TODO(send): Approval records intent and the final email body only -- it does
  // NOT send anything. The platform has no mail provider wired yet. When the
  // send step is built, this is where an approved card's email goes out and
  // sent_at / sent_to (migration 0007) get populated.

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

  return NextResponse.json({ card: data });
}
