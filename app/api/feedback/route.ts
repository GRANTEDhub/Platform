import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Record an analyst's QA judgment on a match. Append-only. Snapshots the
// engine's state (score / seat_ref / reasoning) at the time so the datapoint is
// self-contained even after a later re-score. References a review_card OR a
// match_attempt (the latter lets feedback target a suppressed score-0 match).
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: {
    review_card_id?: string;
    match_attempt_id?: string;
    agree?: boolean;
    corrected_score?: number;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.agree !== "boolean") {
    return NextResponse.json({ error: "agree (boolean) is required" }, { status: 400 });
  }
  if (!body.review_card_id && !body.match_attempt_id) {
    return NextResponse.json(
      { error: "Must reference a review_card_id or match_attempt_id" },
      { status: 400 },
    );
  }
  // On a Flag (disagree) we require a WHY -- the reason is the calibration signal.
  // A corrected score is optional (the dock captures the reason, not a re-score);
  // when provided it must be in range. Older callers that send a corrected_score
  // still work; the reason is now the required field.
  if (!body.agree) {
    if (!body.reason || !body.reason.trim()) {
      return NextResponse.json(
        { error: "A reason is required when you flag the score" },
        { status: 400 },
      );
    }
    if (
      body.corrected_score !== undefined &&
      (typeof body.corrected_score !== "number" ||
        body.corrected_score < 0 ||
        body.corrected_score > 3)
    ) {
      return NextResponse.json(
        { error: "corrected_score, if given, must be 0-3" },
        { status: 400 },
      );
    }
  }

  // Derive identity + snapshot the engine state from the referenced row.
  let grant_id: string | null = null;
  let client_id: string | null = null;
  let engine_score: number | null = null;
  let engine_seat_ref: string | null = null;
  let engine_reasoning: unknown = null;

  if (body.review_card_id) {
    const { data: card } = await supabase
      .from("review_cards")
      .select("grant_id, client_id, fit_score, reasoning_context")
      .eq("id", body.review_card_id)
      .maybeSingle();
    if (!card) {
      return NextResponse.json({ error: "Review card not found" }, { status: 404 });
    }
    grant_id = card.grant_id;
    client_id = card.client_id;
    engine_score = card.fit_score;
    engine_reasoning = card.reasoning_context;
    // seat_ref isn't stored on the card -- pull it from the latest attempt.
    const { data: att } = await supabase
      .from("match_attempts")
      .select("result")
      .eq("grant_id", grant_id)
      .eq("client_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1);
    const r = att?.[0]?.result as { seat_ref?: string } | undefined;
    engine_seat_ref = r?.seat_ref ?? null;
  } else {
    const { data: att } = await supabase
      .from("match_attempts")
      .select("grant_id, client_id, fit_score, result")
      .eq("id", body.match_attempt_id!)
      .maybeSingle();
    if (!att) {
      return NextResponse.json({ error: "Match attempt not found" }, { status: 404 });
    }
    grant_id = att.grant_id;
    client_id = att.client_id;
    engine_score = att.fit_score;
    const r = att.result as { seat_ref?: string; reasoning_context?: unknown } | undefined;
    engine_seat_ref = r?.seat_ref ?? null;
    engine_reasoning = r?.reasoning_context ?? null;
  }

  const { data, error } = await supabase
    .from("match_feedback")
    .insert({
      grant_id,
      client_id,
      review_card_id: body.review_card_id ?? null,
      match_attempt_id: body.match_attempt_id ?? null,
      agree: body.agree,
      corrected_score: body.agree ? null : body.corrected_score,
      reason: body.reason ?? null,
      engine_score,
      engine_seat_ref,
      engine_reasoning,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to record feedback" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}
