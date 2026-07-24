import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient } from "@/lib/supabase/server";
import { computeGrantSummary } from "@/lib/review/summary";
import { ensureConceptProposalPlaceholder, runConceptProposalGeneration } from "@/lib/concept/store";
import type { CardDecision, PursuitPath } from "@/types/database";

// Re-exported so existing importers (DecisionPanel, DecisionConfirmation) keep
// their `@/app/api/review/[id]/route` type import; the source of truth is the
// shared helper, which the grant-alert send path also uses.
export type { GrantSummary, DecidedResult } from "@/lib/review/summary";

// Record a review-card decision, OR mark it "interested" (Grant Alerts' gate ahead
// of the Grant Report -- a separate, lower-stakes signal from decision; see
// migration 0057), OR (account-managed clients only) record the SEPARATE,
// staff-only SME pass (sme_interested / sme_release -- see migration 0059).
// Reject ('passed') and Reset ('pending') come through here; client approval +
// the actual send are owned by the grant-alert route (POST
// /api/alerts/[cardId]/send), which also stamps 'approved'. RLS + the
// guard_card_approval trigger still enforce that only admins can set 'approved'.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: {
    decision?: CardDecision;
    decision_reason?: string;
    interested?: boolean;
    sme_interested?: boolean;
    sme_release?: boolean;
    pursuit_path?: PursuitPath | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Which side is acting? Staff have a profiles row; client portal members don't.
  // (A client can't read profiles under RLS, so this self-lookup returns null for
  // them, which correctly resolves to 'client'.) Stamped for actor attribution.
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  const actor = prof ? "staff" : "client";

  // SME-only writes (account-managed clients' own staff pass). Staff-only by
  // construction -- a client sending either of these is rejected outright; the
  // guard trigger would also fail-closed-block it, but reject explicitly here so
  // the error is clear rather than a generic 500.
  if (body.sme_interested || body.sme_release) {
    if (actor !== "staff") {
      return NextResponse.json({ error: "Staff only" }, { status: 403 });
    }
    const update = body.sme_release
      ? { sme_released_at: new Date().toISOString(), sme_released_by: user.id }
      : { sme_interested_at: new Date().toISOString(), sme_interested_by: user.id };
    const { data, error } = await supabase
      .from("review_cards")
      .update(update)
      .eq("id", params.id)
      .select()
      .single();
    if (error) {
      return NextResponse.json({ error: "Failed to update card" }, { status: 500 });
    }
    // On the SME "interested" pass (account-managed clients, 0059), kick off the
    // concept proposal so it's ready when the AM opens the grant. Non-blocking:
    // the swipe returns immediately; generation runs in the background and flips
    // the row generating -> ready/error. Only on a FRESH create, so an existing or
    // manually edited proposal is never clobbered. Never on release, never for
    // prospect / grant-less cards. Additive to the interest write -- touches no
    // locked file (concept_proposals is its own table).
    if (body.sme_interested && data.grant_id && data.client_id && data.card_type !== "prospect") {
      const { created } = await ensureConceptProposalPlaceholder(
        data.id,
        data.grant_id,
        data.client_id,
        user.id,
      );
      if (created) waitUntil(runConceptProposalGeneration(data.id, user.id));
    }
    return NextResponse.json({ card: data, grant_summary: null });
  }

  // Interest-only write (Grant Alerts right-swipe): does not touch decision at all.
  if (body.interested && !body.decision) {
    const { data, error } = await supabase
      .from("review_cards")
      .update({ interested_at: new Date().toISOString(), interested_by: user.id, interested_by_actor: actor })
      .eq("id", params.id)
      .select()
      .single();
    if (error) {
      return NextResponse.json({ error: "Failed to update card" }, { status: 500 });
    }
    return NextResponse.json({ card: data, grant_summary: null });
  }

  // Pursuit-path write (the client picks HOW to pursue from the Grant Report:
  // IntellEngine / SME / in-house). Records the card as pursued (approved) AND
  // the chosen path in one update -- the 0061 client column-lock permits both.
  // Re-routable (a new pick overwrites); null clears back to a pending decision.
  if (body.pursuit_path !== undefined && !body.decision) {
    const validPaths: PursuitPath[] = ["intellengine", "sme", "in_house"];
    const path = body.pursuit_path;
    if (path !== null && !validPaths.includes(path)) {
      return NextResponse.json({ error: "Invalid pursuit path" }, { status: 400 });
    }
    const pursuing = path !== null;
    const { data, error } = await supabase
      .from("review_cards")
      .update({
        pursuit_path: path,
        decision: pursuing ? "approved" : "pending",
        decided_by: pursuing ? user.id : null,
        decided_at: pursuing ? new Date().toISOString() : null,
        decided_by_actor: pursuing ? actor : null,
      })
      .eq("id", params.id)
      .select()
      .single();
    if (error) {
      const isApprovalBlock = error.message?.toLowerCase().includes("approve");
      return NextResponse.json(
        { error: isApprovalBlock ? "Only admins can approve a match for client delivery" : "Failed to update card" },
        { status: isApprovalBlock ? 403 : 500 },
      );
    }
    return NextResponse.json({ card: data, grant_summary: null });
  }

  const valid: CardDecision[] = ["pending", "approved", "passed"];
  if (!body.decision || !valid.includes(body.decision)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }

  const isTerminal = body.decision !== "pending";
  const { data, error } = await supabase
    .from("review_cards")
    .update({
      decision: body.decision,
      decision_reason: body.decision === "passed" ? body.decision_reason || null : null,
      decided_by: isTerminal ? user.id : null,
      decided_at: isTerminal ? new Date().toISOString() : null,
      decided_by_actor: isTerminal ? actor : null,
      // Save-for-later / Pass means "no longer pursuing via any path" -- clear it.
      // A generic 'approved' (staff/alert path) leaves the path untouched.
      pursuit_path: body.decision === "approved" ? undefined : null,
    })
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    // The approval trigger raises for non-admins trying to approve.
    const isApprovalBlock = error.message?.toLowerCase().includes("approve");
    return NextResponse.json(
      { error: isApprovalBlock ? "Only admins can approve a match for client delivery" : "Failed to update card" },
      { status: isApprovalBlock ? 403 : 500 },
    );
  }

  // Post-decision summary for the Matches confirmation screen; null for
  // prospect / non-grant cards.
  const grant_summary = isTerminal
    ? await computeGrantSummary(supabase, { card_type: data.card_type, grant_id: data.grant_id })
    : null;

  return NextResponse.json({ card: data, grant_summary });
}
