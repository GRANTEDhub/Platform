import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { computeGrantSummary } from "@/lib/review/summary";
import { recordCardFeedback } from "@/lib/feedback/record";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantReleaseEmail } from "@/lib/email/send";
import { canNotifyClient } from "@/lib/clients/portal-gate";
import { appBaseUrl } from "@/lib/site-url";
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
    // Capture prior release state so the client is emailed only on the null ->
    // set transition -- re-releasing an already-released card must not re-notify.
    let firstRelease = false;
    if (body.sme_release) {
      const { data: prior } = await supabase
        .from("review_cards")
        .select("sme_released_at")
        .eq("id", params.id)
        .maybeSingle<{ sme_released_at: string | null }>();
      firstRelease = !prior?.sme_released_at;
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
    // On the FIRST release of a card to the client, notify them by email with a
    // deep link to the released grant. The in-app bell already picks up
    // sme_released_at on its own, so this is the email half only. Fire-and-forget
    // via waitUntil: the release is the source of truth and must succeed even if
    // the email is gated off (preview / not on the allowlist) or Resend errors.
    if (body.sme_release && firstRelease && data?.client_id && data?.grant_id) {
      waitUntil(notifyClientOfRelease(params.id, data.client_id, data.grant_id));
    }
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

// Background (waitUntil) notify: emails the client's primary contact that a new
// grant match has been released, with a deep link into their Grant Alerts view.
// Runs after the response and uses the service-role client (the request-scoped
// RLS client is tied to the finished request). NEVER throws -- a gated or failed
// send must not affect the release, which already succeeded. Mirrors the
// concept-generation background trigger's error contract.
async function notifyClientOfRelease(cardId: string, clientId: string, grantId: string): Promise<void> {
  try {
    const db = createServiceClient();
    const [{ data: client }, { data: grant }] = await Promise.all([
      db
        .from("clients")
        .select("primary_contact_email, primary_contact_name")
        .eq("id", clientId)
        .maybeSingle<{ primary_contact_email: string | null; primary_contact_name: string | null }>(),
      db.from("grants").select("title").eq("id", grantId).maybeSingle<{ title: string | null }>(),
    ]);

    const to = client?.primary_contact_email ?? null;
    // HOLD until the client actually has a portal seat. The onboarding sequence now
    // matches and reviews grants BEFORE the client is invited, so a release firing in
    // that window would email a link to a portal they cannot log into. The invite is
    // the release.
    const seat = await canNotifyClient(db, clientId);
    if (!seat.ok) {
      console.log(`[release-notify] held card=${cardId}: ${seat.reason}`);
      return;
    }
    // Same combined gate as every outreach send: prod + enabled + key + on the
    // testing allowlist. A blocked send logs why and returns cleanly.
    const gate = canSendOutreach(to);
    if (!gate.ok) {
      console.log(`[release-notify] skipped card=${cardId}: ${gate.reason}`);
      return;
    }

    const url = `${appBaseUrl()}/portal/grants/${cardId}?from=alerts`;
    const sent = await sendGrantReleaseEmail({
      to: to as string,
      contactName: client?.primary_contact_name ?? null,
      grantTitle: grant?.title ?? null,
      url,
    });
    console.log(`[release-notify] sent card=${cardId} to=${sent.to} id=${sent.id}`);
  } catch (e) {
    console.error(`[release-notify] failed card=${cardId}:`, e instanceof Error ? e.message : e);
  }
}
