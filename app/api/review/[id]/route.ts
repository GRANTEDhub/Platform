import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { computeGrantSummary } from "@/lib/review/summary";
import { recordCardFeedback } from "@/lib/feedback/record";
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
    // RELEASE NO LONGER EMAILS. It used to fire a second, bare notice ("New grant match
    // ready to review | <grant>") with a portal link and no PDF, so a client who was
    // released-then-alerted received two emails about one grant under two different
    // subjects. The grant alert is the notification -- it carries the one-pager and the
    // one-click Interested / Pass links -- so "GRANTED Alert: <grant>" is now the only
    // subject a client ever sees for a grant.
    //
    // Release still does everything else it did: sme_released_at makes the card visible in
    // the client's portal deck, and the in-app bell picks that up on its own (it always
    // did -- the deleted code was the email half only).
    //
    // No auto-generation of the concept proposal here anymore. With the single AM
    // review gate (Gate 1 / sme_interested triage removed), the concept proposal is
    // generated MANUALLY from the review panel only when the AM decides it's
    // warranted (POST /api/concept/[cardId]) -- never automatically on an interest
    // pass. Keeps costly generation opt-in and never clobbers a manual edit.
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
    // Pursuit is gated off for clients (lib/pursuit/access.ts), and THIS is the write the
    // hidden chooser option used to make -- the one that stamps decision='approved' +
    // pursuit_path='intellengine'. Hiding the option card closed the only live caller, but
    // not the endpoint: a hand-crafted PATCH still lands the card in exactly the state the
    // gate exists to prevent, a card claiming a pursuit route the client cannot walk. RLS
    // and guard_card_approval do not help -- the 0061 column-lock permits a client to set
    // both columns on their own card by design, and neither knows about the flag.
    //
    // ONLY the intellengine path is refused. Gating the whole branch would break the two
    // paths that DO work (sme, in_house), and null has to stay reachable because clearing
    // is how a client backs out of a choice recorded before the gate went up -- the
    // self-recovery the chooser's "Remove this choice" control depends on. Checked after
    // the path match so the common case never pays for the profile lookup.
    if (path === "intellengine" && (await pursuitApiDenied())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  // A Pass WITH a reason is the calibration signal now (replacing the old
  // standalone agree/flag control): record it to match_feedback as a negative
  // datapoint (agree=false, reason=the why). Best-effort -- the decision above is
  // the source of truth and already committed, so a feedback-store failure must not
  // fail the reject. No reason -> no datapoint (an empty pass carries no signal).
  if (body.decision === "passed" && body.decision_reason?.trim()) {
    try {
      await recordCardFeedback(supabase, {
        reviewCardId: params.id,
        createdBy: user.id,
        agree: false,
        reason: body.decision_reason.trim(),
      });
    } catch (e) {
      console.error(`[review-reject] feedback record failed card=${params.id}:`, e instanceof Error ? e.message : e);
    }
  }

  // Post-decision summary for the Matches confirmation screen; null for
  // prospect / non-grant cards.
  const grant_summary = isTerminal
    ? await computeGrantSummary(supabase, { card_type: data.card_type, grant_id: data.grant_id })
    : null;

  return NextResponse.json({ card: data, grant_summary });
}
