import type { createClient } from "@/lib/supabase/server";

// Append a calibration datapoint to match_feedback (migration 0013) for a review
// card, snapshotting the engine's state (score / seat_ref / reasoning) so the row
// is self-contained after a later re-score. This mirrors the card-path snapshot in
// POST /api/feedback and is the single writer used by the reject path: a Pass with
// a reason is a negative signal on the match (agree=false), and the reason is the
// calibration text. Best-effort by contract -- callers wrap it so a feedback-store
// failure never blocks the decision it rides on. Uses the request-scoped RLS client,
// so it's authorized the same way the caller is (staff via is_staff(); a client
// member via is_client_member_of() -- 0056/0057).
export async function recordCardFeedback(
  supabase: ReturnType<typeof createClient>,
  opts: {
    reviewCardId: string;
    createdBy: string;
    agree: boolean;
    reason?: string | null;
    correctedScore?: number | null;
  },
): Promise<{ id: string }> {
  const { data: card } = await supabase
    .from("review_cards")
    .select("grant_id, client_id, fit_score, reasoning_context")
    .eq("id", opts.reviewCardId)
    .maybeSingle();
  if (!card) throw new Error("Review card not found");

  // seat_ref isn't stored on the card -- pull it from the latest attempt (a SELECT
  // the client may not be able to read; empty -> null seat_ref, which is fine).
  const { data: att } = await supabase
    .from("match_attempts")
    .select("result")
    .eq("grant_id", card.grant_id)
    .eq("client_id", card.client_id)
    .order("created_at", { ascending: false })
    .limit(1);
  const r = att?.[0]?.result as { seat_ref?: string } | undefined;

  const { data, error } = await supabase
    .from("match_feedback")
    .insert({
      grant_id: card.grant_id,
      client_id: card.client_id,
      review_card_id: opts.reviewCardId,
      match_attempt_id: null,
      agree: opts.agree,
      corrected_score: opts.agree ? null : opts.correctedScore ?? null,
      reason: opts.reason ?? null,
      engine_score: card.fit_score,
      engine_seat_ref: r?.seat_ref ?? null,
      engine_reasoning: card.reasoning_context,
      created_by: opts.createdBy,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id };
}
