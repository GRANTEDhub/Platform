import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient, enrichMatchWithProfile } from "@/lib/grants/engine";
import { funderExclusionReason } from "@/lib/grants/constraints";
import { cardFieldsFromMatch } from "@/lib/grants/pipeline";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { grantFactSummary } from "@/lib/grants/format";
import { resolveCheckGrantAccess } from "@/lib/clients/check-grant-access";
import type { Grant, Client } from "@/types/database";

export const maxDuration = 300;

// "Check a grant" scorer — the client-keyed sibling of app/api/grants/[id]/add-client.
// Given a client (params.id) + a confirmed grant (body.grantId), run one real
// matchGrantToClient score and REPORT the verdict.
//
// Difference from add-client: this is a "tell me if we're a fit" read, so a
// not-a-fit answer is a valid RESULT, not a block to override. No soft/hard override
// dialogs — it always returns a verdict.
//
// Reuses the exact locked scorer (matchGrantToClient + enrichMatchWithProfile) and
// the shared card shape (cardFieldsFromMatch), so a persisted card is byte-identical
// to an engine- or add-client-created one.
//
// TWO ACTORS, AND THE DIFFERENCE IS WHETHER IT WRITES (resolveCheckGrantAccess):
//   staff   PERSISTS a qualifying pair (fit >= 2, not disqualified/suppressed), matching
//           the engine's own qualification rule, so a check populates the roadmap with
//           genuine matches and stays quiet otherwise.
//   client  REPORT-ONLY. A self-scored grant writes nothing. A card written from the
//           portal would appear in that client's own Grant Report having never passed
//           the SME release gate — for an account-managed client that gate is the point
//           of the portal — and it would also hand a client the power to put work on
//           their account manager's queue. So the answer is the deliverable: the grant's
//           facts plus why it fits them or why it doesn't.
//
// EVERY response carries `summary` (the grant stated as facts) and, where there is one,
// `rationale`. That is what makes a "not a fit" answer useful rather than a dead end:
// the previous shape returned a bare verdict with `reason` populated only for a
// disqualify/suppress, so a fit_score of 1 came back as the word "Weak" and nothing else.
type Verdict = "fit" | "weak" | "no" | "excluded";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // Any staff profile, as before; plus a portal member for their OWN org.
  const access = await resolveCheckGrantAccess(params.id, { staffRole: "any" });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const canPersist = access.actor === "staff";

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
  // Deterministic, identical for both actors: the facts come out of the ledger row, not
  // out of the model, so the summary cannot drift from what the grant page shows.
  const summary = grantFactSummary(grant);

  // If this pair is already matched, surface the existing card's read rather than
  // spending an LLM call (and the unique constraint would block a second card anyway).
  const { data: existing } = await db
    .from("review_cards")
    .select(
      "id, fit_score, why_this_org, concept_synopsis, before_you_approve, proposed_role, recommended_prime, outreach_track, reasoning_context, sme_released_at, card_type",
    )
    .eq("grant_id", grant.id)
    .eq("client_id", client.id)
    .maybeSingle();

  // WHETHER THE CALLER IS ALLOWED TO KNOW THE CARD EXISTS. A prospect card is not part
  // of this client's book at all; and for an account-managed client an unreleased card is
  // deliberately invisible in the portal — saying "already on your report" here would
  // announce a match staff have not released yet, which is the one thing the SME gate
  // exists to prevent. In that case the check falls through and scores fresh: the client
  // gets a real, honest read and learns nothing about our queue.
  const existingVisible =
    existing !== null &&
    existing.card_type !== "prospect" &&
    (canPersist || !client.account_managed || existing.sme_released_at !== null);

  if (existing && existingVisible) {
    const fs = Number(existing.fit_score) || 1;
    return NextResponse.json({
      grant: grantMeta,
      summary,
      alreadyMatched: true,
      cardId: existing.id,
      persisted: true,
      verdict: (fs >= 2 ? "fit" : "weak") as Verdict,
      fit_score: fs,
      seat_ref: null,
      proposed_role: existing.proposed_role ?? null,
      recommended_prime: existing.recommended_prime ?? null,
      why_this_org: existing.why_this_org ?? [],
      concept_synopsis: existing.concept_synopsis ?? null,
      // Staff-only, same reason as the fresh-score branch: a persisted card's before_you_approve
      // can carry entity_screen / role_ceiling constraint notes (staff-authored client text).
      before_you_approve: canPersist ? existing.before_you_approve ?? [] : [],
      rationale: rationaleFrom(existing.reasoning_context),
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
      summary,
      verdict: "excluded" as Verdict,
      reason: "International — excluded by GRANTED's domestic-only policy.",
      rationale: null,
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
      summary,
      verdict: "no" as Verdict,
      reason: funderBlock,
      rationale: null,
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
  // Grant not fully shredded yet -> the read may be thin; say so rather than present
  // it as settled (IntellEngine's "surface inferred-vs-confirmed" discipline). This note is
  // client-safe (it's about the grant, not the client).
  const processingNote =
    grant.status !== "complete"
      ? [
          `This grant is still processing (status: ${grant.status}) — the fit read may be incomplete; re-check once it has finished ingesting.`,
        ]
      : [];
  // before_you_approve carries STAFF-authored constraint notes (do_not_surface_for / entity_screen /
  // role_ceiling), and those embed a client's own `note` text — e.g. a service line the client is
  // quietly exiting. It is staff pre-send review guidance and MUST NOT reach a client actor (a
  // portal member self-checking their own org). A client gets only the benign processing note.
  const beforeApprove = canPersist
    ? [...processingNote, ...(cardFields.before_you_approve ?? [])]
    : processingNote;

  const verdict: Verdict = match.disqualified || match.suppressed || match.fit_score === 0
    ? "no"
    : match.fit_score >= 2
      ? "fit"
      : "weak";

  // Persist a pending card ONLY for a real fit AND only for staff (see the header note).
  let persisted = false;
  if (verdict === "fit" && canPersist) {
    const { error: insErr } = await db.from("review_cards").insert({
      grant_id: grant.id,
      client_id: client.id,
      ...cardFields,
      before_you_approve: beforeApprove,
      decision: "pending",
      // Audit: stamp human-added provenance (like add-client) so a checked-in match is
      // distinguishable from an engine-surfaced one. Not an override -> reason stays null.
      overridden_by: access.userId,
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
    summary,
    alreadyMatched: false,
    persisted,
    // Report-only, and said so explicitly rather than left for the reader to infer from
    // persisted:false — which for staff means "scored but didn't qualify" and for a
    // client means "we never write from here", two different facts.
    reportOnly: !canPersist,
    verdict,
    // suppress_reason on a do_not_surface_for match embeds the client's staff-authored
    // contraindication note (confidential — their exited service line, phrased for internal eyes).
    // Staff see it verbatim; a client actor gets a generic client-safe line instead of our internal
    // strategy about them. disqualify_reason is model-produced eligibility prose (already shown to
    // clients via the portal), so it stays as-is for both.
    reason: match.disqualified
      ? match.disqualify_reason ?? null
      : match.suppressed
        ? canPersist
          ? match.suppress_reason ?? null
          : "This grant isn't a fit for your organization right now."
        : null,
    // Third leak channel, same class as reason/before_you_approve: the contraindication note is
    // injected into the model prompt (formatConstraintsForPrompt), so the model can echo it into
    // eligibility_analysis/fit_score_derivation — the two fields rationaleFrom surfaces. Gate it for
    // a client actor on a suppressed match. Staff, and any non-suppressed client read (a normal
    // "why it doesn't fit"), still get the full rationale.
    rationale: !canPersist && match.suppressed ? null : rationaleFrom(match.reasoning_context),
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

// WHY this score — eligibility read first, then the derivation. Exactly the pair
// /review/[id] joins for its reasoning panel, and fit_score_derivation is already shown
// to clients on the portal grant detail, so this surfaces nothing new: it answers "why it
// doesn't fit", which why_this_org (a fit's bullets) structurally cannot.
//
// Deliberately NOT the other four reasoning_context fields: role_assignment_logic,
// consortium_rationale, concept_derivation and why_not_others are internal strategy and
// in why_not_others' case about OTHER clients.
function rationaleFrom(rc: unknown): string | null {
  if (!rc || typeof rc !== "object") return null;
  const r = rc as Record<string, unknown>;
  const parts = [r.eligibility_analysis, r.fit_score_derivation]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length ? parts.join("\n\n") : null;
}
