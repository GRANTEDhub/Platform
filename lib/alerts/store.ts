import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { uploadPdf, downloadPdf, removeObjects } from "@/lib/storage";
import { mintAccessToken } from "@/lib/tokens";
import { enrichAlert } from "./enrich";
import { buildAlertData, buildAlertEmailBody, buildProspectEmailBody } from "./data";
import { senderFirstName } from "./sender";
import { renderAlertPdf, renderHorizonPdf } from "./render";
import { mergeAlertPdfs } from "./merge-pdf";
import { getForecastHorizon } from "@/lib/grants/forecast-relevance";
import type { AlertContext } from "./generate";
import type { AlertData, AlertEnrichment } from "./types";
import type { Client } from "@/types/database";

// Persistence for the grant alert: generate ONCE, save the exact AlertData +
// enrichment + rendered PDF, and reuse that saved version for both preview and
// send -- so what the admin reviewed is byte-for-byte what the client receives.
// The PDF lives in the private 'grant-alerts' bucket; metadata in grant_alerts.
// All writes are service-role (the table is admin-only RLS). See migration 0035.

export const GRANT_ALERTS_BUCKET = "grant-alerts";

export type GrantAlertRow = {
  id: string;
  card_id: string;
  grant_id: string | null;
  client_id: string | null;
  prospect_id: string | null;
  status: "draft" | "sent";
  alert_data: AlertData;
  enrichment: AlertEnrichment | null;
  storage_bucket: string;
  storage_path: string;
  subject: string | null;
  email_body: string | null;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  sent_to: string | null;
};

// The current (at most one) draft alert for a card -- the partial unique index
// grant_alerts_one_draft_per_card guarantees uniqueness.
export async function getDraftAlert(cardId: string): Promise<GrantAlertRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from("grant_alerts")
    .select("*")
    .eq("card_id", cardId)
    .eq("status", "draft")
    .maybeSingle<GrantAlertRow>();
  return data ?? null;
}

// Generate a fresh draft: enrich (narrative) + deterministic facts -> render ->
// upload PDF -> insert row. Replaces any existing draft (and deletes its stale
// PDF) so "Regenerate" is a clean swap. This is the ONLY place enrich + render
// run for the alert; preview and send both reuse the row this produces.
export async function generateDraftAlert(
  ctx: AlertContext,
  userId: string | null,
  origin: string,
  opts?: { withHorizon?: boolean },
): Promise<GrantAlertRow> {
  const db = createServiceClient();

  const prior = await getDraftAlert(ctx.card.id);
  if (prior) {
    // Remove the prior draft's PDF AND its horizon page (if any) so a regenerate is a
    // clean swap and never orphans a stale horizon object.
    const priorHorizon = (prior.alert_data as AlertData)?.horizonStoragePath;
    await removeObjects(prior.storage_bucket, [prior.storage_path, ...(priorHorizon ? [priorHorizon] : [])]);
    await db.from("grant_alerts").delete().eq("id", prior.id);
  }

  const enrichment = await enrichAlert(ctx.grant, ctx.card);
  const alertData = buildAlertData(ctx.grant, ctx.card, enrichment);

  // Cold-outreach alerts carry a clickable booking link in the PDF, minted HERE at
  // render time so it's baked into the saved PDF (preview == sent). Two cold cases:
  //   - a discovery PROSPECT card -> a prospect-scoped token; the lead doesn't exist
  //     yet, and /go resolves the prospect token for the recipient.
  //   - a LEAD client card (Tara-build manual prospect) -> a lead-scoped token
  //     (clientId of the already-existing lead). /go handles both action types.
  // A warm CLIENT alert (active client) gets NO booking link.
  if (origin && ctx.card.card_type === "prospect" && ctx.prospect) {
    const minted = await mintAccessToken(db, {
      actionType: "prospect_schedule_call",
      prospectId: ctx.prospect.id,
      grantId: ctx.grant.id,
      createdBy: userId,
    });
    if (minted) alertData.schedulingUrl = `${origin}/go/${minted.rawToken}`;
  } else if (origin && ctx.isLead && ctx.client) {
    const minted = await mintAccessToken(db, {
      actionType: "lead_schedule_call",
      clientId: ctx.client.id,
      grantId: ctx.grant.id,
      createdBy: userId,
    });
    if (minted) alertData.schedulingUrl = `${origin}/go/${minted.rawToken}`;
  }

  const pdf = await renderAlertPdf(alertData);

  // Warm CLIENT alerts get the short facts body; COLD alerts (a discovery PROSPECT
  // card OR a LEAD client card / Tara-build prospect) get the salutation +
  // sender-named intro + credential block + scheduling CTA. The sender's first name
  // is resolved from the draft creator's profile at draft time (draft creator ==
  // sender under preview == sent), null-safe to a name-less intro.
  let emailBody: string;
  if (ctx.card.card_type === "prospect" || ctx.isLead) {
    let sender: { full_name: string | null; email: string | null } | null = null;
    if (userId) {
      const { data } = await db.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
      sender = data ?? null;
    }
    emailBody = buildProspectEmailBody(ctx.grant, ctx.card, senderFirstName(sender), !!alertData.schedulingUrl);
  } else {
    emailBody = buildAlertEmailBody(ctx.grant, ctx.card);
  }

  const id = randomUUID();
  const storagePath = `${ctx.card.id}/${id}.pdf`;
  await uploadPdf(GRANT_ALERTS_BUCKET, storagePath, pdf);

  const insert = {
    id,
    card_id: ctx.card.id,
    grant_id: ctx.grant.id,
    client_id: ctx.client?.id ?? null,
    prospect_id: ctx.prospect?.id ?? null,
    status: "draft" as const,
    alert_data: alertData,
    enrichment,
    storage_bucket: GRANT_ALERTS_BUCKET,
    storage_path: storagePath,
    subject: `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`,
    email_body: emailBody,
    created_by: userId,
  };
  const { data, error } = await db.from("grant_alerts").insert(insert).select().single<GrantAlertRow>();
  if (error) throw new Error(`Failed to save alert draft: ${error.message}`);
  // Single-send drafts get the forecasted horizon computed + frozen now; batch prepare
  // passes no opts (withHorizon falsy) so it never pays for a horizon it won't render.
  return opts?.withHorizon ? ensureHorizon(ctx, data) : data;
}

// Reuse the existing draft if present; otherwise generate one. `origin` is the
// stable base URL for the baked-in booking link (only used when generating).
// `withHorizon` (single-send paths only) computes + freezes the forecasted horizon,
// backfilling an existing draft that lacks one (e.g. a batch-prepared or pre-feature
// draft) so single-send always carries it; batch prepare omits it (no horizon).
export async function getOrCreateDraftAlert(
  ctx: AlertContext,
  userId: string | null,
  origin: string,
  opts?: { withHorizon?: boolean },
): Promise<GrantAlertRow> {
  const existing = await getDraftAlert(ctx.card.id);
  if (existing) return opts?.withHorizon ? ensureHorizon(ctx, existing) : existing;
  return generateDraftAlert(ctx, userId, origin, opts);
}

// Compute the forecasted "on the horizon" set for a client/lead draft and FREEZE it
// in alert_data (preview == sent). Idempotent + cheap to call on every single-send
// view: presence of `forecastHorizon` (even []) means already computed. Renders the
// horizon page to a SEPARATE object (never the shared per-card PDF, so the batch merge
// stays horizon-free). Discovery-prospect drafts (no client row) get nothing. Any
// failure is swallowed -- the page-1 alert is the essential artifact, so a missing
// horizon is a soft omission, never a send blocker (retried on the next view).
async function ensureHorizon(ctx: AlertContext, alert: GrantAlertRow): Promise<GrantAlertRow> {
  if (!ctx.client) return alert;
  const data = (alert.alert_data ?? {}) as AlertData;
  if (data.forecastHorizon !== undefined) return alert; // computed + frozen already
  const db = createServiceClient();
  try {
    const { data: fullClient } = await db.from("clients").select("*").eq("id", ctx.client.id).single<Client>();
    if (!fullClient) return alert;
    // Per-client research-grants opt-in (migration 0051): flows to
    // isResearchExcludedFunder so NIH/research grants surface only for an opted-in org.
    const horizon = await getForecastHorizon(db, fullClient, { researchOptIn: fullClient.research_opt_in });
    const patch: Partial<AlertData> = { forecastHorizon: horizon };
    if (horizon.length > 0) {
      const horizonPath = `${ctx.card.id}/${alert.id}-horizon.pdf`;
      const pdf = await renderHorizonPdf(
        horizon.map((h) => ({ title: h.title, funder: h.funder, rationale: h.rationale })),
      );
      await uploadPdf(alert.storage_bucket, horizonPath, pdf);
      patch.horizonStoragePath = horizonPath;
    }
    const newData = { ...data, ...patch };
    const { data: updated } = await db
      .from("grant_alerts")
      .update({ alert_data: newData })
      .eq("id", alert.id)
      .select()
      .single<GrantAlertRow>();
    return updated ?? { ...alert, alert_data: newData };
  } catch (err) {
    console.error(`[horizon] compute/render failed for alert ${alert.id}; proceeding without horizon:`, err);
    return alert;
  }
}

// Assemble the OUTWARD single-send PDF: the saved page-1 alert, with the forecasted
// horizon page concatenated when the draft has one. Used by the single-send preview
// (pdf route) AND the single-send path, so preview == sent. The batch path never calls
// this (it loads + merges base PDFs directly), so a horizon never appears in a batch
// send. A horizon-download/merge failure degrades to the base alert, never blocks send.
export async function assembleOutwardAlertPdf(alert: GrantAlertRow): Promise<Buffer> {
  const base = await loadAlertPdf(alert);
  const horizonPath = (alert.alert_data as AlertData)?.horizonStoragePath;
  if (!horizonPath) return base;
  try {
    const horizon = await downloadPdf(alert.storage_bucket, horizonPath);
    return await mergeAlertPdfs([base, horizon]);
  } catch (err) {
    console.error(`[assemble] horizon concat failed for alert ${alert.id}; sending base only:`, err);
    return base;
  }
}

// The saved PDF bytes for an alert (from the bucket -- no re-render).
export async function loadAlertPdf(alert: GrantAlertRow): Promise<Buffer> {
  return downloadPdf(alert.storage_bucket, alert.storage_path);
}

// Concurrency guards for the SINGLE send path (double-send prevention):
//
//  - findSentAlert: does this card already have a delivered alert? Used to REFUSE
//    a sequential re-send ("a sent card stays sent") BEFORE any draft is
//    (re)generated or any email fires.
//  - claimAlertForSend: the atomic claim. A conditional flip draft->sent that
//    only succeeds for the ONE caller who finds the row still 'draft'; a
//    concurrent caller gets `false` and must NOT email. Sets a provisional
//    sent_to so a crash between claim and finalize doesn't leave a recipient-less
//    "sent" row. Run this immediately BEFORE the Resend call.
//  - releaseAlertClaim: rollback. If the email throws after a successful claim,
//    return the row to 'draft' so it isn't stuck "sent" with nothing delivered
//    and can be retried.

// The card's delivered alert, if any (most recent). Presence => refuse re-send.
export async function findSentAlert(
  cardId: string,
): Promise<{ id: string; sent_to: string | null; sent_at: string | null } | null> {
  const db = createServiceClient();
  const { data } = await db
    .from("grant_alerts")
    .select("id, sent_to, sent_at")
    .eq("card_id", cardId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; sent_to: string | null; sent_at: string | null }>();
  return data ?? null;
}

// Atomically claim a draft for sending: flip draft->sent for exactly the caller
// who still sees it as 'draft'. Returns true iff THIS caller won the claim (1 row
// updated); false means a concurrent send already claimed/sent it -> do not email.
export async function claimAlertForSend(id: string, recipient: string): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("grant_alerts")
    .update({ status: "sent", sent_at: new Date().toISOString(), sent_to: recipient })
    .eq("id", id)
    .eq("status", "draft")
    .select("id");
  if (error) throw new Error(`Failed to claim alert for send: ${error.message}`);
  return (data?.length ?? 0) === 1;
}

// Roll a claimed-but-unsent alert back to 'draft' (Resend failed after the
// claim), so it isn't stuck "sent" and can be retried. Scoped to still-'sent'
// rows so it never clobbers a genuinely finalized send.
export async function releaseAlertClaim(id: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db
    .from("grant_alerts")
    .update({ status: "draft", sent_at: null, sent_to: null })
    .eq("id", id)
    .eq("status", "sent");
  if (error) console.error(`Failed to release alert claim ${id}: ${error.message}`);
}

// Mark a draft as sent -- immutable thereafter (a later alert for the same card
// creates a new draft). Persists the exact subject/body that went out.
export async function markAlertSent(
  id: string,
  opts: { sentTo: string; subject: string; emailBody: string; clientId?: string | null },
): Promise<void> {
  const db = createServiceClient();
  const update: Record<string, unknown> = {
    status: "sent",
    sent_at: new Date().toISOString(),
    sent_to: opts.sentTo,
    subject: opts.subject,
    email_body: opts.emailBody,
  };
  // For a prospect alert, client_id is filled here with the lead the prospect was
  // promoted into on send (it was null on the draft).
  if (opts.clientId) update.client_id = opts.clientId;
  const { error } = await db.from("grant_alerts").update(update).eq("id", id);
  if (error) throw new Error(`Failed to mark alert sent: ${error.message}`);
}
