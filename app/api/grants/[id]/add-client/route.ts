import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient, enrichMatchWithProfile } from "@/lib/grants/engine";
import { funderExclusionReason } from "@/lib/grants/constraints";
import { cardFieldsFromMatch } from "@/lib/grants/pipeline";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Grant, Client } from "@/types/database";

export const maxDuration = 300;

// Add-to-Client blocks come in two severities. SOFT = the engine's judgment call
// (structural suppression / grant-level skip_reason / low fit) -- the human
// legitimately disagreeing, override with a light confirm. HARD = a genuine
// eligibility problem (post-score disqualification / an ineligible-funder client
// constraint) -- forcing risks wasted work on something the client can't pursue,
// so it takes an explicit warning + confirm. International is neither: it is the
// firm's domestic-only mandate, a non-overridable dead-stop (handled up top, no
// override path).
type OverrideAck = "soft" | "hard";
type Severity = "soft" | "hard";

// A "hard" acknowledgment covers hard AND soft gates; a "soft" ack covers only
// soft. So overriding a soft block that then surfaces a hard one re-blocks (the
// UI escalates to the hard dialog) -- a soft click can never blow past a hard
// warning the human never saw.
function ackCovers(ack: OverrideAck | null, sev: Severity): boolean {
  if (ack === "hard") return true;
  if (ack === "soft") return sev === "soft";
  return false;
}

// Admin-only "Add to Client": manually match a client the engine didn't surface.
// Runs a real single-pair matchGrantToClient score on demand (bypassing the
// engine's jsPreFilter surfacing heuristic -- intended) and creates a card
// IDENTICAL in shape to an engine match, so it engages the client-first gate,
// appears in Matches, and flows to the dashboard on approval like any other.
//
// Override policy: SOFT/HARD blocks are overridable with a matching ack (see
// above); the created card records who forced it, when, and past what (audit
// trail, migration 0040). Low fit is always overridable (it is just the engine's
// opinion) and forced cards are floored to fit 1 so a disqualified 0 never lands
// a 0-of-3 card. Auth / already-matched / not-found / unconverted-lead / the
// domestic-only mandate stay non-overridable.
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

  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    override?: OverrideAck;
  };
  if (!body.clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  const ack: OverrideAck | null = body.override === "hard" || body.override === "soft" ? body.override : null;

  const db = createServiceClient();

  const { data: grant } = await db.from("grants").select("*").eq("id", params.id).single<Grant>();
  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }
  // International = hard, NON-overridable dead-stop. Domestic-only is a firm-wide
  // mandate, not a per-grant judgment, so there is deliberately no override path:
  // overridable:false, and this returns before any override handling below.
  if (!grant.is_domestic) {
    return NextResponse.json(
      {
        error: "International grant — excluded by GRANTED's domestic-only policy. This cannot be overridden.",
        blocked: "international",
        severity: "hard",
        overridable: false,
      },
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
  // Defense-in-depth: the picker only offers status='active' clients, but this
  // route scores whatever id it is handed -- never score an un-converted lead.
  if (isUnconvertedLead(client.pipeline_stage)) {
    return NextResponse.json(
      { error: "That organization is a lead, not a client. Convert it first." },
      { status: 400 },
    );
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

  // Override audit accumulator: the highest-severity gate this add is FORCED past
  // (hard outranks soft). Drives override_reason + the before_you_approve note on
  // the created card. Null => nothing overridden (a clean or plain low-fit add).
  let crossed: { severity: Severity; reason: string } | null = null;
  const recordCrossed = (severity: Severity, reason: string) => {
    if (!crossed || (severity === "hard" && crossed.severity === "soft")) {
      crossed = { severity, reason };
    }
  };

  // A blocked gate: if the ack covers this severity, record it and proceed; else
  // return the 422 the UI turns into the soft inline confirm or the hard dialog.
  const blockOrNull = (severity: Severity, blockedKey: string, reason: string, message: string) => {
    if (ackCovers(ack, severity)) {
      recordCrossed(severity, reason);
      return null;
    }
    return NextResponse.json(
      { error: message, blocked: blockedKey, severity, overridable: true, reason },
      { status: 422 },
    );
  };

  // ── PRE-SCORE gates (hard first, so the human sees the most severe) ──────────

  // HARD: an ineligible-funder client constraint. Deterministic + client-specific;
  // matchGrantToClient does NOT re-check it (jsPreFilter, which enforces it in the
  // normal pipeline, is not on this manual path), so it must be gated here or it
  // silently never fires on a manual add.
  const funderBlock = funderExclusionReason(grant.funder, client);
  if (funderBlock) {
    const resp = blockOrNull(
      "hard",
      "ineligible_funder",
      funderBlock,
      `Not added — ${funderBlock}. This is a hard eligibility constraint you set, not a fit score.`,
    );
    if (resp) return resp;
  }

  // SOFT: grant-level structural suppression (single national award / fixed-slot
  // TTA -- nobody has a realistic prime path). The engine's judgment; overridable.
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
    const resp = blockOrNull(
      "soft",
      "skip_reason",
      grant.skip_reason,
      `The engine structurally suppressed this grant: ${grant.skip_reason}. Nobody has a clear prime path — add anyway?`,
    );
    if (resp) return resp;
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

  // ── POST-SCORE gates (hard first) ───────────────────────────────────────────

  // HARD: disqualification -- triage found no viable route (entity type ineligible,
  // an ineligible_entities clause the client falls under, geography, etc.).
  if (match.disqualified) {
    const reason = match.disqualify_reason ?? "no reason given";
    const resp = blockOrNull(
      "hard",
      "disqualified",
      reason,
      `Not added — ${client.name} is hard-disqualified for this grant: ${reason}. This is an eligibility constraint, not a fit score.`,
    );
    if (resp) return resp;
  }

  // SOFT: structural suppression the scorer surfaced (program architecture /
  // client capacity) -- the engine's judgment, overridable.
  if (match.suppressed) {
    const reason = match.suppress_reason ?? "no reason given";
    const resp = blockOrNull(
      "soft",
      "suppressed",
      reason,
      `The engine structurally suppressed ${client.name} for this grant: ${reason}. Add anyway?`,
    );
    if (resp) return resp;
  }

  // Allowed: create the card. Identical shape to an engine card (shared
  // cardFieldsFromMatch) + card_type defaults to 'client'. Profile-grounded
  // narrative enrichment first -- self-gates on surfacing + profile presence and
  // cannot change the seat/score (see enrichMatchWithProfile); best-effort.
  match = await enrichMatchWithProfile(grant, client, match);
  const cardFields = cardFieldsFromMatch(match);
  const beforeApprove = [...(cardFields.before_you_approve ?? [])];
  let overrideReason: string | null = null;

  // Audit + reviewer surfacing when the add was FORCED past a gate. The
  // before_you_approve note is the load-bearing part: it rides into the approve /
  // send flow where a card badge is easy to miss.
  const cx = crossed as { severity: Severity; reason: string } | null;
  if (cx) {
    overrideReason = `${cx.severity}: ${cx.reason}`;
    beforeApprove.unshift(
      cx.severity === "hard"
        ? `MANUAL OVERRIDE past a HARD eligibility block: ${cx.reason}. This match was forced past an eligibility warning — verify the applicant route (partner / subrecipient?) before sending.`
        : `MANUAL OVERRIDE past the engine's suppression: ${cx.reason}. The engine did not recommend this match; confirm the pursuit is worth the effort before sending.`,
    );
  }

  const { error: insErr } = await db.from("review_cards").insert({
    grant_id: params.id,
    client_id: body.clientId,
    ...cardFields,
    // Floor to 1: a disqualified / no-seat match can score 0, but review_cards
    // .fit_score is 1|2|3 and the ring/band render 1-3. A human adding it asserts
    // it is worth tracking; the true engine read stays in reasoning_context.
    fit_score: Math.max(1, match.fit_score) as 1 | 2 | 3,
    before_you_approve: beforeApprove,
    decision: "pending",
    // Audit trail (0040): stamped on EVERY manual add so human-added is
    // distinguishable from engine-surfaced; override_reason is set only when forced.
    overridden_by: user.id,
    overridden_at: new Date().toISOString(),
    override_reason: overrideReason,
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

  return NextResponse.json({
    added: true,
    fit_score: match.fit_score,
    client_name: client.name,
    overridden: overrideReason !== null,
  });
}
