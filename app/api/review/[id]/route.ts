import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeGrantSummary } from "@/lib/review/summary";
import type { CardDecision } from "@/types/database";

// Re-exported so existing importers (DecisionPanel, DecisionConfirmation) keep
// their `@/app/api/review/[id]/route` type import; the source of truth is the
// shared helper, which the grant-alert send path also uses.
export type { GrantSummary, DecidedResult } from "@/lib/review/summary";

// Record a review-card decision, OR mark it "interested" (Grant Alerts' gate ahead
// of the Grant Report -- a separate, lower-stakes signal from decision; see
// migration 0057). Reject ('passed') and Reset ('pending') come through here;
// client approval + the actual send are owned by the grant-alert route (POST
// /api/alerts/[cardId]/send), which also stamps 'approved'. RLS + the
// guard_card_approval trigger still enforce that only admins can set 'approved'.
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

  let body: { decision?: CardDecision; decision_reason?: string; interested?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Which side is acting? Staff have a profiles row; client portal members don't.
  // (A client can't read profiles under RLS, so this self-lookup returns null for
  // them, which correctly resolves to 'client'.) Stamped for actor attribution.
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  const actor = prof ? "staff" : "client";

  // Interest-only write (Grant Alerts right-swipe): does not touch decision at all.
  if (body.interested && !body.decision) {
    const { data, error } = await supabase
      .from("review_cards")
      .update({ interested_at: new Date().toISOString(), interested_by: user.id, interested_by_actor: actor })
      .eq("id", params.id)
      .select()
      .single();
    if (error) {
      return NextResponse.json({ error: "Failed to update card" }, { status: 500 });
    }
    return NextResponse.json({ card: data, grant_summary: null });
  }

  const valid: CardDecision[] = ["pending", "approved", "passed"];
  if (!body.decision || !valid.includes(body.decision)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }

  const isTerminal = body.decision !== "pending";
  const { data, error } = await supabase
    .from("review_cards")
    .update({
      decision: body.decision,
      decision_reason: body.decision === "passed" ? body.decision_reason || null : null,
      decided_by: isTerminal ? user.id : null,
      decided_at: isTerminal ? new Date().toISOString() : null,
      decided_by_actor: isTerminal ? actor : null,
    })
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    // The approval trigger raises for non-admins trying to approve.
    const isApprovalBlock = error.message?.toLowerCase().includes("approve");
    return NextResponse.json(
      { error: isApprovalBlock ? "Only admins can approve a match for client delivery" : "Failed to update card" },
      { status: isApprovalBlock ? 403 : 500 },
    );
  }

  // Post-decision summary for the Matches confirmation screen; null for
  // prospect / non-grant cards.
  const grant_summary = isTerminal
    ? await computeGrantSummary(supabase, { card_type: data.card_type, grant_id: data.grant_id })
    : null;

  return NextResponse.json({ card: data, grant_summary });
}
