import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import type { Client, FactorScores, Grant } from "@/types/database";

export const maxDuration = 300;

// Backfill the per-factor breakdown on ONE card that predates factor scoring.
//
// Per-factor sub-scores shipped 2026-07-27 (migration 0038) with no backfill and no
// re-score sweep, so every card matched before that date has factor_scores = null and
// the review screen renders "no per-factor breakdown" — on the exact panel the screen is
// built around. Nothing in the product fixed it: "Refresh matches" skips already-attempted
// pairs (lib/clients/match-queue.ts) and check-grant returns early when a card exists.
// This is the one-card, on-demand fix, driven from that empty panel.
//
// IT WRITES factor_scores AND NOTHING ELSE. 0038 called the column "additive and
// DESCRIPTIVE ONLY"; that has to hold for the backfill too, or a reviewer who wanted a
// breakdown would silently get a re-scored card — a different seat, a different fit_score,
// a different recommended prime, possibly a card that no longer qualifies at all. Every
// other field the scorer returns is read and discarded here.
//
// GUARDED TO NULL. If a breakdown already exists this is a no-op 409, so the route cannot
// be used as an undocumented re-score button by pointing it at a current card.
//
// IT COSTS A FULL SCORER CALL. factor_scores is emitted by the scoring tool as part of
// reaching fit_score — there is no cheaper call that produces the six ratings on their
// own. One card at a time, staff-triggered, is the whole design: a sweep over the backlog
// would be a large spend for cards nobody is looking at.
//
// SCORE DRIFT IS REPORTED, NOT WRITTEN. The model can reach a different fit_score today
// than it did months ago. When it does, the breakdown we just saved describes a verdict
// the card does not show. We still keep the breakdown (the six ratings are the useful
// part, and they are what was asked for) and return both numbers so the caller can say so
// out loud, rather than quietly pairing one card's score with another run's reasoning.

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Staff only. A portal member has no profiles row and could not read one under RLS
  // anyway — spending a scorer call is not theirs to trigger.
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!prof) return NextResponse.json({ error: "Staff only" }, { status: 403 });

  const db = createServiceClient();

  const { data: card } = await db
    .from("review_cards")
    .select("id, client_id, grant_id, fit_score, factor_scores")
    .eq("id", params.id)
    .maybeSingle<{
      id: string;
      client_id: string | null;
      grant_id: string | null;
      fit_score: number | null;
      factor_scores: FactorScores | null;
    }>();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (card.factor_scores) {
    return NextResponse.json({ error: "This card already has a factor breakdown." }, { status: 409 });
  }
  if (!card.client_id || !card.grant_id) {
    return NextResponse.json({ error: "Card is missing its client or grant — nothing to score." }, { status: 400 });
  }

  const [{ data: client }, { data: grant }] = await Promise.all([
    db.from("clients").select("*").eq("id", card.client_id).single<Client>(),
    db.from("grants").select("*").eq("id", card.grant_id).single<Grant>(),
  ]);
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  // USASpending parity with runMatching / add-client / check-grant: read the STORED
  // cache, never fetch live; a verified client's own history is authoritative.
  const usaSpendingContext = client.federal_history_verified
    ? undefined
    : formatStoredUSASpending(client.usaspending_summary);

  let match;
  try {
    match = await matchGrantToClient(grant, client, usaSpendingContext);
  } catch (err) {
    return NextResponse.json(
      { error: `Scoring failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  if (!match.factor_scores) {
    return NextResponse.json({ error: "The scorer returned no factor breakdown." }, { status: 502 });
  }

  // The one write. Conditioned on factor_scores STILL being null so two reviewers pressing
  // at once cannot have the slower call overwrite the faster one's breakdown.
  const { data: written, error } = await db
    .from("review_cards")
    .update({ factor_scores: match.factor_scores })
    .eq("id", card.id)
    .is("factor_scores", null)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if ((written ?? []).length === 0) {
    return NextResponse.json({ error: "Another breakdown was saved while this one was scoring." }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    storedFitScore: card.fit_score,
    freshFitScore: match.fit_score,
    drifted: card.fit_score !== null && match.fit_score !== card.fit_score,
  });
}
