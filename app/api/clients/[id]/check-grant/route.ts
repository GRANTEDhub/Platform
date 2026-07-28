import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient, enrichMatchWithProfile } from "@/lib/grants/engine";
import { funderExclusionReason } from "@/lib/grants/constraints";
import { cardFieldsFromMatch } from "@/lib/grants/pipeline";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Grant, Client } from "@/types/database";

export const maxDuration = 300;

// Client-dashboard "Check a grant" scorer — the client-keyed sibling of
// app/api/grants/[id]/add-client. Given a client (params.id) + a confirmed grant
// (body.grantId), run one real matchGrantToClient score and REPORT the verdict.
//
// Difference from add-client: this is a "tell me if we're a fit" read, so a
// not-a-fit answer is a valid RESULT, not a block to override. No soft/hard override
// dialogs — it always returns a verdict. It only PERSISTS a review card when the
// pair genuinely qualifies (fit >= 2, not disqualified/suppressed), matching the
// engine's own qualification rule (scoreGrantClientPair) so the dashboard/roadmap
// never fills with no-fit clutter. A qualifying check adds the grant to this client's
// roadmap; a weak/no answer just reports and adds nothing.
//
// Reuses the exact locked scorer (matchGrantToClient + enrichMatchWithProfile) and
// the shared card shape (cardFieldsFromMatch), so a persisted card is byte-identical
// to an engine- or add-client-created one.
type Verdict = "fit" | "weak" | "no" | "excluded";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { grantId?: string };
  if (!body.grantId) return NextResponse.json({ error: "grantId is required" }, { status: 400 });

  const db = createServiceClient();

  const { data: client } = await db.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (isUnconvertedLead(client.pipeline_stage)) {
    return NextResponse.json({ error: "That record is a lead, not a client. Convert it first." }, { status: 400 });
  }

  const { data: grant } = await db.from("grants").select("*").eq("id", body.grantId).single<Grant>();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const grantMeta = { id: grant.id, title: grant.title, funder: grant.funder };

  // If this pair is already matched, surface the existing card's read rather than
  // spending an LLM call (and the unique constraint would block a second card anyway).
  const { data: existing } = await db
    .from("review_cards")
    .select("fit_score, why_this_org, concept_synopsis, before_you_approve, proposed_role, recommended_prime, outreach_track")
    .eq("grant_id", grant.id)
    .eq("client_id", client.id)
    .maybeSingle();
  if (existing) {
    const fs = Number(existing.fit_score) || 1;
    return NextResponse.json({
      grant: grantMeta,
      alreadyMatched: true,
      persisted: true,
      verdict: (fs >= 2 ? "fit" : "weak") as Verdict,
      fit_score: fs,
      seat_ref: null,
      proposed_role: existing.proposed_role ?? null,
      recommended_prime: existing.recommended_prime ?? null,
      why_this_org: existing.why_this_org ?? [],
      concept_synopsis: existing.concept_synopsis ?? null,
      before_you_approve: existing.before_you_approve ?? [],
      inferred_fields: [],
      disqualified: false,
      suppressed: false,
      outreach_track: existing.outreach_track ?? null,
    });
  }

  // International = domestic-only dead-stop. A valid "no" for a fit check. NULL is
  // treated as domestic (the ledger's `?? true` convention) — only an explicit false excludes.
  if (grant.is_domestic === false) {
    return NextResponse.json({
      grant: grantMeta,
      verdict: "excluded" as Verdict,
      reason: "International — excluded by GRANTED's domestic-only policy.",
      fit_score: 0,
      why_this_org: [],
      before_you_approve: [],
      inferred_fields: [],
      disqualified: true,
      suppressed: false,
      persisted: false,
    });
  }

  // A client-specific ineligible-funder constraint (deterministic; matchGrantToClient
  // does not re-check it off the pipeline). If it fires, it's a hard "no" — report it
  // without spending an LLM call.
  const funderBlock = funderExclusionReason(grant.funder, client);
  if (funderBlock) {
    return NextResponse.json({
      grant: grantMeta,
      verdict: "no" as Verdict,
      reason: funderBlock,
      fit_score: 0,
      why_this_org: [],
      before_you_approve: [],
      inferred_fields: [],
      disqualified: true,
      suppressed: false,
      persisted: false,
    });
  }

  // USASpending parity with runMatching / add-client: read the STORED cache, never
  // fetch live; verified clients are authoritative.
  const usaSpendingContext = client.federal_history_verified
    ? undefined
    : formatStoredUSASpending(client.usaspending_summary);

  let match;
  try {
    match = await matchGrantToClient(grant, client, usaSpendingContext);
    match = await enrichMatchWithProfile(grant, client, match);
  } catch (err) {
    return NextResponse.json(
      { error: `Scoring failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  const cardFields = cardFieldsFromMatch(match);
  const beforeApprove = [...(cardFields.before_you_approve ?? [])];
  // Grant not fully shredded yet -> the read may be thin; say so rather than present
  // it as settled (IntellEngine's "surface inferred-vs-confirmed" discipline).
  if (grant.status !== "complete") {
    beforeApprove.unshift(
      `This grant is still processing (status: ${grant.status}) — the fit read may be incomplete; re-check once it has finished ingesting.`,
    );
  }

  const verdict: Verdict = match.disqualified || match.suppressed || match.fit_score === 0
    ? "no"
    : match.fit_score >= 2
      ? "fit"
      : "weak";

  // Persist a pending card ONLY for a real fit (mirrors the engine's qualify rule), so
  // "Check a grant" populates the roadmap with genuine matches and stays quiet otherwise.
  let persisted = false;
  if (verdict === "fit") {
    const { error: insErr } = await db.from("review_cards").insert({
      grant_id: grant.id,
      client_id: client.id,
      ...cardFields,
      before_you_approve: beforeApprove,
      decision: "pending",
      // Audit: stamp human-added provenance (like add-client) so a checked-in match is
      // distinguishable from an engine-surfaced one. Not an override -> reason stays null.
      overridden_by: user.id,
      overridden_at: new Date().toISOString(),
      override_reason: null,
    });
    // 23505 = a concurrent add/engine run created the card first; treat as persisted.
    persisted = !insErr || (insErr as { code?: string }).code === "23505";
    if (insErr && (insErr as { code?: string }).code !== "23505") {
      console.error("check-grant card insert failed:", insErr);
    }
  }

  return NextResponse.json({
    grant: grantMeta,
    alreadyMatched: false,
    persisted,
    verdict,
    reason: match.disqualified ? match.disqualify_reason ?? null : match.suppressed ? match.suppress_reason ?? null : null,
    fit_score: match.fit_score,
    seat_ref: match.seat_ref ?? null,
    proposed_role: match.proposed_role ?? null,
    recommended_prime: match.recommended_prime ?? null,
    why_this_org: match.why_this_org ?? [],
    concept_synopsis: match.concept_synopsis ?? null,
    before_you_approve: beforeApprove,
    inferred_fields: match.inferred_fields ?? [],
    disqualified: !!match.disqualified,
    suppressed: !!match.suppressed,
    outreach_track: match.outreach_track ?? null,
  });
}
