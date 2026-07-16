import "server-only";
import type { createClient, createServiceClient } from "@/lib/supabase/server";
import { markAlertSent } from "@/lib/alerts/store";
import { convertProspectToLead, type ConvertOutcome } from "@/lib/prospects/convert";
import type { Prospect } from "@/types/database";

// Per-card state mutations for the grant-alert send, factored out of the single
// send route so they can be reused VERBATIM by the aggregate (multi-select) send.
//
// The single and aggregate paths differ only in delivery -- one email vs. one
// merged email for N cards -- never in the resulting platform state. To make that
// true by construction, each card's effects split into a PRE-EMAIL half and a
// POST-EMAIL half, with the Resend call as the injectable middle:
//   client:   recordClientDecision   -> [email] -> finalizeClientCardSent
//   prospect: prospectConvertForSend  -> [email] -> finalizeProspectSent
// The single route calls these around its one email; the batch runs every card's
// pre-email half, sends ONE merged email, then runs every post-email half. Only
// the state mutations live here (reused); the single-email orchestration and the
// claim/rollback primitives (claimAlertForSend/releaseAlertClaim, already in
// store.ts) stay with their callers, because the batch orchestrates differently.
//
// Client-type is behavior-critical and preserved per call: the client leaves take
// the USER-scoped client (review_cards writes go through the admin-only approval
// RLS trigger + card stamps); the prospect leaves take the SERVICE client
// (clients/prospects/hooks/events). markAlertSent uses its own service client.

// ── Client, pre-email: record the terminal approval ─────────────────────────
// Sending a client card IS its approval. Recorded FIRST, via the USER client so
// the admin-only approval trigger validates, and it STANDS even if the email is
// later blocked/unsent (mirrors the prior plain-text approve). Returns a semantic
// result; the caller maps it to HTTP (403 on an approval block, 500 otherwise).
export type ClientDecisionResult = { ok: true } | { ok: false; reason: "approval_forbidden" | "error" };

export async function recordClientDecision(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  userId: string,
  finalBody: string,
): Promise<ClientDecisionResult> {
  const { error } = await supabase
    .from("review_cards")
    .update({
      decision: "approved",
      decision_reason: null,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      final_outreach_email: finalBody,
    })
    .eq("id", cardId);
  if (error) {
    const isApprovalBlock = error.message?.toLowerCase().includes("approve");
    return { ok: false, reason: isApprovalBlock ? "approval_forbidden" : "error" };
  }
  return { ok: true };
}

// ── Client, post-email: finalize the delivered alert ────────────────────────
// Marks the draft sent (immutable thereafter) and stamps the card's sent_at/sent_to
// via the USER client (same RLS-scoped write the route used). Call only after a
// successful email.
export async function finalizeClientCardSent(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  alertId: string,
  sentTo: string,
  subject: string,
  emailBody: string,
): Promise<void> {
  await markAlertSent(alertId, { sentTo, subject, emailBody });
  await supabase
    .from("review_cards")
    .update({ sent_at: new Date().toISOString(), sent_to: sentTo })
    .eq("id", cardId);
}

// ── Prospect, pre-email: sync contact + promote to a tracked lead ───────────
// Remembers the confirmed contact email on the prospect (keeps it in sync with what
// is actually sent, and carries it to the lead), then promotes the prospect into a
// tracked lead (idempotent: reuses an existing lead / client). No schedule token --
// the booking link is baked into the PDF at draft time (prospect-scoped); this call
// is purely for pipeline tracking. Returns the convert outcome (the caller handles
// the routed_to_client short-circuit).
export async function prospectConvertForSend(
  db: ReturnType<typeof createServiceClient>,
  opts: { prospect: Prospect; grantId: string; userId: string; recipient: string },
): Promise<ConvertOutcome> {
  const { prospect, grantId, userId, recipient } = opts;
  await db.from("prospects").update({ primary_contact_email: recipient }).eq("id", prospect.id);
  prospect.primary_contact_email = recipient;
  return convertProspectToLead(db, {
    prospect,
    grantId,
    userId,
    contactEmail: recipient,
    contactName: prospect.primary_contact_name,
    mintScheduleToken: false,
  });
}

// ── Prospect, post-email: finalize the delivered alert ──────────────────────
// Marks the draft sent (filling client_id with the lead the prospect was promoted
// into) and records the pipeline event. Call only after a successful email. No
// decision is written for a prospect (that would pollute client dashboards).
export async function finalizeProspectSent(
  db: ReturnType<typeof createServiceClient>,
  opts: {
    alertId: string;
    sentTo: string;
    subject: string;
    emailBody: string;
    conv: ConvertOutcome;
    prospect: Prospect;
    grantId: string;
  },
): Promise<void> {
  const { alertId, sentTo, subject, emailBody, conv, prospect, grantId } = opts;
  await markAlertSent(alertId, { sentTo, subject, emailBody, clientId: conv.clientId });
  await db.from("pipeline_events").insert({
    event_type: "grant_alert_sent",
    client_id: conv.clientId,
    prospect_id: prospect.id,
    grant_id: grantId,
    subject_snapshot: { name: prospect.name },
    metadata: { to: sentTo },
  });
}

// ── Lead (Tara-build manual prospect), post-email: finalize the delivered alert ──
// A lead is an unconverted CLIENT row matched against the full pool like a client,
// but pitched COLD. Post-email: mark the draft sent and record the pipeline event
// (feeds the lead's scheduling panel -- how we track whether the pitch converts).
// NO decision is written (a lead isn't a serviced client, so it must not pollute
// client-decision data) and NO convert (it's already a lead). The grant_alerts row
// already carries client_id from draft time, so markAlertSent needs no clientId.
export async function finalizeLeadSent(
  db: ReturnType<typeof createServiceClient>,
  opts: { alertId: string; sentTo: string; subject: string; emailBody: string; clientId: string; grantId: string; clientName: string | null },
): Promise<void> {
  const { alertId, sentTo, subject, emailBody, clientId, grantId, clientName } = opts;
  await markAlertSent(alertId, { sentTo, subject, emailBody });
  await db.from("pipeline_events").insert({
    event_type: "grant_alert_sent",
    client_id: clientId,
    grant_id: grantId,
    subject_snapshot: { name: clientName },
    metadata: { to: sentTo },
  });
}
