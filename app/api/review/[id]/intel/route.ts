import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runIntelReview, type IntelCard } from "@/lib/grants/intel-review";
import type { Client, Grant } from "@/types/database";

export const maxDuration = 300;

// Admin-only: run the on-demand IntellEngine QA pass on ONE surfaced card ("Run IntellEngine Intel").
// The annotate-only sibling of /rematch — it does NOT re-score and NEVER calls scoreGrantClientPair.
//
// PROPOSAL-ONLY, ENFORCED HERE: this route writes EXACTLY ONE column, intel_review. It never touches
// fit_score / seat / decision / suppressed, so QA can never remove or re-score a card. The verdict
// says "engine 3 → QA says 1, here's the web-grounded reason"; a human makes the call. (There is no
// pending/released/processing gate like /rematch has: this staff write is authoritative and always wins.
// The automatic QA pass (lib/grants/intel-queue.ts) is the side that yields — it pre-checks for an
// existing verdict and writes ON CONFLICT DO NOTHING, so it can never clobber this on-demand one.)
//
// STAFF-ONLY / NEVER CLIENT-FACING: intel_review is raw internal QA voice. The client portal query,
// the Grant Report, emails, and concept/PDF exports do NOT select it and must never start.
//
// A MODEL error 502s and stores nothing (no QA yet — retry). A "ran but could not web-ground it"
// outcome is a real stored verdict:"unverified" (runIntelReview returns it; it does not throw).
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
      "id, client_id, grant_id, fit_score, proposed_role, recommended_prime, why_this_org, before_you_approve, reasoning_context",
    )
    .eq("id", params.id)
    .maybeSingle<
      IntelCard & { id: string; client_id: string | null; grant_id: string | null }
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

  // THE WRITE, to the STAFF-ONLY card_intel_reviews table — never review_cards, so nothing here can
  // change the card's score/seat/decision, AND (unlike a review_cards column) a client member has no
  // RLS policy that admits them to read it. One current verdict per card (upsert on review_card_id).
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

  return NextResponse.json({ ok: true, intel });
}
