import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { scoreGrantClientPair } from "@/lib/grants/pipeline";
import { classifyRematch } from "@/lib/report/rematch-outcome";
import type { Client, Grant } from "@/types/database";

export const maxDuration = 300;

// Admin-only: re-score ONE existing review card on demand, against the grant's STORED
// shred + ideal_applicant_profile (no re-fetch of the NOFO). The single-card companion to
// the grant-level "Re-match clients" button — that one re-scores the whole roster; this
// one re-scores exactly the pair a reviewer is looking at, without spending the roster.
//
// IT REUSES scoreGrantClientPair VERBATIM (lib/grants/pipeline.ts) — the same persist-safely
// primitive the drain, the roster re-match, and the client-first match all run through, so
// this pair scores through a provably identical path. That primitive owns every guard:
// it refreshes a pending card in place, DELETES a pending card that no longer qualifies
// (the engine's own surface threshold), leaves a human-DECIDED card untouched, and records
// a match_attempts row for the outcome. We add nothing to it.
//
// PENDING + UNRELEASED ONLY. A decided card is the human's call and scoreGrantClientPair
// would no-op on it anyway; a released card is one a client may already be looking at, and
// silently refreshing its narrative underneath them is not this button's job. Both are
// rejected up front so we never spend a scorer call that changes nothing (or something we
// don't want changed). The UI also hides the button in those states — this is the backstop.
//
// This is the ENGINE re-score half of the two-button split: it can drop a card. The QA /
// IntellEngine Intel pass (a later brick) is the other half — it only annotates and
// proposes, never removes — and will plug in alongside this, not replace it.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Admin-only, matching the other score-mutating actions (Add to Client, the grant-level
  // re-match): a re-score that can remove a surfaced card is not a general staff action.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();

  const { data: card } = await db
    .from("review_cards")
    .select("id, client_id, grant_id, decision, sme_released_at, fit_score")
    .eq("id", params.id)
    .maybeSingle<{
      id: string;
      client_id: string | null;
      grant_id: string | null;
      decision: string;
      sme_released_at: string | null;
      fit_score: number | null;
    }>();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (!card.client_id || !card.grant_id) {
    // Prospect cards have a null client_id; an orphaned card has no grant. Neither is a
    // client-pair this scorer can re-run.
    return NextResponse.json({ error: "This card has no client/grant pair to re-score." }, { status: 400 });
  }
  if (card.decision !== "pending") {
    return NextResponse.json(
      { error: "This card has already been decided — re-matching would not change it." },
      { status: 409 },
    );
  }
  if (card.sme_released_at) {
    return NextResponse.json(
      { error: "This card has been released to the client — not re-scoring it from here." },
      { status: 409 },
    );
  }

  const [{ data: client }, { data: grant }] = await Promise.all([
    db.from("clients").select("*").eq("id", card.client_id).single<Client>(),
    db.from("grants").select("*").eq("id", card.grant_id).single<Grant>(),
  ]);
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  // Refuse while a roster scoring episode is live (processing / queued / matching). A per-card
  // re-score would RACE runMatching's cursor-free resume: it writes a match_attempts row at
  // `now`, which is at/after the episode marker, so scoredClientIdsSince then counts this client
  // as already-scored-this-episode and the roster run SKIPS it -- leaving a card scored against
  // the OLD profile during a re-shred that is rebuilding it. It is also redundant while the whole
  // roster is being scored anyway. The UI hides the control in these states; this is the backstop.
  if (grant.status === "processing" || grant.status === "queued" || grant.status === "matching") {
    return NextResponse.json(
      { error: "This grant is being scored right now — re-match a single card once it finishes." },
      { status: 409 },
    );
  }

  const storedFitScore = card.fit_score;

  // The latest attempt for this pair BEFORE we score, so we can tell OUR attempt row from a
  // stale one. recordAttempt SWALLOWS an insert failure, so a post-scoring "latest attempt"
  // could otherwise be an older run's -- and we would report its (prefiltered / error / removal)
  // reason as if it were this run's. We trust the post-scoring attempt only if it is strictly
  // newer than this. (Both timestamps are DB-side match_attempts.created_at, same clock; and the
  // status gate above rules out a concurrent roster run writing an attempt for this pair.)
  const { data: priorAttempt } = await db
    .from("match_attempts")
    .select("created_at")
    .eq("grant_id", card.grant_id)
    .eq("client_id", card.client_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>();
  const priorAt = priorAttempt?.created_at ?? null;

  // The re-score + safe persist. scoreGrantClientPair swallows its own errors (it records an
  // 'error' attempt rather than throwing), so this await resolves even on a scoring failure;
  // the outcome is read back from the attempt row below, not from a thrown exception.
  await scoreGrantClientPair(grant, client, db);

  // Read the outcome scoreGrantClientPair just wrote, then re-read the card to see whether it
  // survived. classifyRematch turns the two into one verdict the button renders.
  const [{ data: attempt }, { data: after }] = await Promise.all([
    db
      .from("match_attempts")
      .select("outcome, fit_score, suppress_reason, disqualify_reason, prefilter_reason, error_detail, created_at")
      .eq("grant_id", card.grant_id)
      .eq("client_id", card.client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{
        outcome: string | null;
        fit_score: number | null;
        suppress_reason: string | null;
        disqualify_reason: string | null;
        prefilter_reason: string | null;
        error_detail: string | null;
        created_at: string;
      }>(),
    db.from("review_cards").select("fit_score").eq("id", params.id).maybeSingle<{ fit_score: number | null }>(),
  ]);

  // Only THIS request's attempt counts. If the insert was swallowed, `attempt` is a stale row
  // (not strictly newer) -> treat it as absent, and classifyRematch falls back to the card state
  // alone (refreshed vs dropped from the re-read), never reporting a previous run's reason.
  const freshAttempt = attempt && (!priorAt || attempt.created_at > priorAt) ? attempt : null;

  const outcome = classifyRematch({
    storedFitScore,
    cardStillExists: !!after,
    attemptOutcome: freshAttempt?.outcome ?? null,
    // Prefer the surviving card's score; fall back to the attempt's when the card is gone.
    freshFitScore: after?.fit_score ?? freshAttempt?.fit_score ?? null,
    suppressReason: freshAttempt?.suppress_reason ?? null,
    disqualifyReason: freshAttempt?.disqualify_reason ?? null,
    prefilterReason: freshAttempt?.prefilter_reason ?? null,
    errorDetail: freshAttempt?.error_detail ?? null,
  });

  // Clear a stored IntellEngine QA verdict ONLY when the card was actually re-scored in place: its
  // "engine N → QA M" comparison is now stale. NOT on a scoring error / pre-filter (the card is
  // unchanged, so the verdict is still valid and possibly expensive to have produced), and NOT on a
  // drop (the FK cascade already removed it). scoreGrantClientPair swallows its errors, so this is
  // gated on the classified outcome, not on the await resolving. Best-effort — never fail the re-match.
  if (outcome.kind === "refreshed") {
    const { error: intelDelErr } = await db.from("card_intel_reviews").delete().eq("review_card_id", params.id);
    if (intelDelErr) console.error("Failed to clear stale intel verdict on re-match for card", params.id, intelDelErr);
  }

  return NextResponse.json({ ok: true, outcome });
}
