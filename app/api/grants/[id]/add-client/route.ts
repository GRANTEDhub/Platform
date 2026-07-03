import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { cardFieldsFromMatch } from "@/lib/grants/pipeline";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import type { Grant, Client } from "@/types/database";

export const maxDuration = 300;

// Admin-only "Add to Client": manually match a client the engine didn't surface.
// Runs a real single-pair matchGrantToClient score on demand (bypassing the
// engine's jsPreFilter surfacing heuristic -- intended) and creates a card
// IDENTICAL in shape to an engine match, so it engages the client-first gate,
// appears in Matches, and flows to the dashboard on approval like any other.
//
// Override policy: a LOW FIT SCORE is the engine's opinion -- overridable expert
// judgment, so we add regardless of it. A HARD DISQUALIFICATION or a grant-level
// SUPPRESSION is a code-enforced legal/eligibility/structural guardrail, NOT a
// fit opinion -- those BLOCK, with a message that says so.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { clientId?: string };
  if (!body.clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: grant } = await db.from("grants").select("*").eq("id", params.id).single<Grant>();
  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }
  if (!grant.is_domestic) {
    return NextResponse.json(
      { error: "International grant — excluded from matching by policy." },
      { status: 400 },
    );
  }

  const { data: client } = await db
    .from("clients")
    .select("*")
    .eq("id", body.clientId)
    .single<Client>();
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Already-matched pre-check (before scoring, so we don't spend an LLM call on a
  // pair that can't be added). Any existing card -- pending or decided -- blocks.
  const { data: existing } = await db
    .from("review_cards")
    .select("id")
    .eq("grant_id", params.id)
    .eq("client_id", body.clientId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: `This grant is already matched to ${client.name}.` },
      { status: 409 },
    );
  }

  // Grant-level guardrail, checked before scoring: skip_reason is genuine
  // ALL-CLIENT structural suppression (single national award / TTA -- nobody can
  // pursue it), so block before spending a scoring call.
  //
  // NOTE: hard_disqualifiers is deliberately NOT a pre-block here. It is defined
  // as "disqualified for ALL clients" but the extraction mis-populates it with
  // per-applicant eligibility clauses (e.g. "for-profit entities ineligible") that
  // an eligible nonprofit would pass -- blocking on its mere presence over-
  // suppressed eligible clients. Per-client eligibility is decided by the score
  // instead: matchGrantToClient reads eligible_entity_types / ineligible_entities
  // / client hard_constraints, so a genuinely-ineligible client is caught by the
  // post-score match.disqualified / match.suppressed block below, while an
  // eligible one scores and is added. (The systemic fix -- tightening extraction
  // + re-shredding -- is a separate follow-up; normal matching still suppresses
  // these grants until then.)
  if (grant.skip_reason) {
    return NextResponse.json(
      {
        error: `Not added — this grant is structurally suppressed: ${grant.skip_reason}. This is an eligibility constraint, not a fit score.`,
        blocked: "constraint",
      },
      { status: 422 },
    );
  }

  // USASpending parity with runMatching: read the STORED cache, never fetch live.
  // Verified clients are authoritative (federal_grant_history wins); an uncached
  // client scores as "unknown".
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

  // GUARDRAIL: block on hard disqualification or structural suppression. These
  // are not overridable -- distinguish the message from a low-fit case.
  if (match.disqualified || match.suppressed) {
    const reason = (match.disqualified ? match.disqualify_reason : match.suppress_reason) ?? "no reason given";
    const kind = match.disqualified ? "hard-disqualified" : "structurally suppressed";
    return NextResponse.json(
      {
        error: `Not added — ${client.name} is ${kind} for this grant: ${reason}. This is an eligibility constraint, not a fit score.`,
        blocked: "constraint",
        fit_score: match.fit_score,
      },
      { status: 422 },
    );
  }

  // Allowed: create the card regardless of a low fit score. Identical shape to an
  // engine card (shared cardFieldsFromMatch) + card_type defaults to 'client'.
  const { error: insErr } = await db.from("review_cards").insert({
    grant_id: params.id,
    client_id: body.clientId,
    ...cardFieldsFromMatch(match),
    decision: "pending",
  });
  if (insErr) {
    // 23505 = unique_violation on review_cards_grant_client_uniq -- a race with a
    // concurrent add or an engine run created the card first. Same friendly block.
    if ((insErr as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: `This grant is already matched to ${client.name}.` },
        { status: 409 },
      );
    }
    console.error("Add-to-client insert failed:", insErr);
    return NextResponse.json({ error: "Failed to create the match card." }, { status: 500 });
  }

  return NextResponse.json({ added: true, fit_score: match.fit_score, client_name: client.name });
}
