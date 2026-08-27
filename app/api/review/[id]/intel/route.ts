import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runIntelReview, type IntelCard, type IntelReview } from "@/lib/grants/intel-review";
import { autoIntelApplyEnabled, buildQaPatch, applyQaPatch } from "@/lib/grants/intel-queue";
import type { Client, FactorScores, Grant } from "@/types/database";

export const maxDuration = 300;

// Admin-only: run the on-demand IntellEngine QA pass on ONE surfaced card ("Run IntellEngine Intel").
// The sibling of /rematch — it does NOT re-score the engine and NEVER calls scoreGrantClientPair.
//
// TWO WRITES (PR E): (1) the raw verdict to card_intel_reviews (always), and (2) — when AUTO_INTEL_APPLY
// is on — the client-safe projection onto the card's qa_* OVERRIDE columns, via the SAME apply helpers the
// auto drain uses. It still NEVER touches the engine's own fit_score / seat / decision / suppressed: the
// score the card DISPLAYS becomes QA's via coalesce(qa_fit_score, fit_score), but the engine's matcher
// record is preserved, and there is no suppress column — a demote only lowers the number, never hides the
// row. Unlike the JAG-only auto sweep, the manual apply runs for ANY CFDA (a human is the fan-out gate) and
// stamps qa_reviewed_by with the acting staff id. This staff write is authoritative and always wins: the
// upsert OVERWRITES any prior verdict (no ignoreDuplicates), and the automatic pass pre-checks + writes ON
// CONFLICT DO NOTHING, so it can never clobber this one. There is no pending/released/processing gate.
//
// STAFF vs CLIENT: the raw intel_review stays STAFF-ONLY in card_intel_reviews (no client RLS policy). Only
// the client-safe qa_* projection (score, factors, source URLs, status) lands on review_cards — the same
// boundary the read layer already enforces (portal shows only `applied` verdicts).
//
// A MODEL error 502s and stores nothing (no QA yet — retry). A "ran but could not web-ground it" outcome
// is a real stored verdict:"unverified" (runIntelReview returns it; it does not throw). The apply-write is
// non-fatal: the verdict is durably saved even if the projection fails, and the response returns `applied`.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();

  const { data: card } = await db
    .from("review_cards")
    .select(
      "id, client_id, grant_id, fit_score, factor_scores, proposed_role, recommended_prime, why_this_org, before_you_approve, reasoning_context",
    )
    .eq("id", params.id)
    .maybeSingle<
      IntelCard & { id: string; client_id: string | null; grant_id: string | null; factor_scores: FactorScores | null }
    >();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (!card.client_id || !card.grant_id) {
    // Prospect cards (null client_id) and orphans aren't a client-match pair to QA.
    return NextResponse.json({ error: "This card has no client/grant pair to review." }, { status: 400 });
  }

  const [{ data: grant }, { data: client }] = await Promise.all([
    // Only the fields the QA context needs — not raw_text (up to 100k).
    db
      .from("grants")
      .select("id, title, funder, assistance_listings, program_type, eligible_entity_types, geographic_eligibility, source_url")
      .eq("id", card.grant_id)
      .single<Grant>(),
    db.from("clients").select("*").eq("id", card.client_id).single<Client>(),
  ]);
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let intel;
  try {
    intel = await runIntelReview(
      {
        fit_score: card.fit_score,
        proposed_role: card.proposed_role,
        recommended_prime: card.recommended_prime,
        why_this_org: card.why_this_org,
        before_you_approve: card.before_you_approve,
        reasoning_context: card.reasoning_context,
      },
      grant,
      client,
      { reviewedBy: user.id },
    );
  } catch (err) {
    // A hard model/tool failure: store NOTHING (leave intel_review null = "no QA yet"), let the human
    // retry, rather than persist a misleading verdict.
    console.error("IntellEngine QA failed for card", params.id, err);
    return NextResponse.json(
      { error: `QA could not run: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // THE VERDICT WRITE, to the STAFF-ONLY card_intel_reviews table. This is the raw internal QA voice —
  // client members have no RLS policy that admits them to read it. `created_by = user.id` marks it a HUMAN
  // on-demand verdict (vs the drain's null). One current verdict per card; the upsert OVERWRITES any prior
  // row (no ignoreDuplicates), so a re-run always refreshes — a stale row never blocks a fresh one.
  const { error } = await db
    .from("card_intel_reviews")
    .upsert(
      { review_card_id: params.id, intel_review: intel, created_by: user.id, updated_at: new Date().toISOString() },
      { onConflict: "review_card_id" },
    );
  if (error) {
    console.error("IntellEngine QA write failed for card", params.id, error);
    return NextResponse.json({ error: "Failed to save the QA verdict." }, { status: 500 });
  }

  // APPLY-THE-GATE, MANUAL PATH (PR E; reconciled in PR G): a human clicking Re-run applies the verdict onto
  // the card's qa_* columns through the SAME buildQaPatch/applyQaPatch the drain uses. ANY CFDA (the human is
  // the fan-out gate), qa_reviewed_by = this staff id, same master flag (AUTO_INTEL_APPLY OFF disables all
  // card rewrites). It never touches the engine's own columns and never hides a card: a demote only lowers
  // the displayed number; affirm / flag / unverified CLEAR any prior override so a reversal can't leave a
  // stale demoted score.
  //
  // Apply the DURABLE verdict — RE-READ from card_intel_reviews, not our in-memory `intel`. A concurrent
  // Re-run on the same card (each session has its own button; last upsert wins, nothing serializes them)
  // could have superseded our copy, and applying the stale one would diverge review_cards from the
  // source-of-truth verdict. Re-reading mirrors the drain's reconciliation; in the common single-analyst
  // case the persisted row IS our just-written verdict.
  let applied = false;
  if (autoIntelApplyEnabled()) {
    const { data: persisted } = await db
      .from("card_intel_reviews")
      .select("intel_review")
      .eq("review_card_id", params.id)
      .maybeSingle<{ intel_review: IntelReview }>();
    if (persisted?.intel_review) {
      const patch = buildQaPatch(
        { id: card.id, fit_score: card.fit_score, factor_scores: card.factor_scores },
        persisted.intel_review,
        new Date().toISOString(),
        user.id,
      );
      applied = await applyQaPatch(db, card.id, patch);
    }
  }

  return NextResponse.json({ ok: true, intel, applied });
}
