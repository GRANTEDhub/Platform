import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { uploadPdf, downloadPdf, removeObjects } from "@/lib/storage";
import { mintAccessToken } from "@/lib/tokens";
import { enrichAlert } from "./enrich";
import { buildAlertData, buildAlertEmailBody, buildProspectEmailBody } from "./data";
import { senderFirstName } from "./sender";
import { renderAlertPdf } from "./render";
import type { AlertContext } from "./generate";
import type { AlertData, AlertEnrichment } from "./types";

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
): Promise<GrantAlertRow> {
  const db = createServiceClient();

  const prior = await getDraftAlert(ctx.card.id);
  if (prior) {
    await removeObjects(prior.storage_bucket, [prior.storage_path]);
    await db.from("grant_alerts").delete().eq("id", prior.id);
  }

  const enrichment = await enrichAlert(ctx.grant, ctx.card);
  const alertData = buildAlertData(ctx.grant, ctx.card, enrichment);

  // Prospect alerts carry a clickable booking link in the PDF. Mint the /go
  // token HERE, at render time, so it's baked into the saved PDF (preview ==
  // sent). The lead doesn't exist yet at draft time, so it's a prospect-scoped
  // token; /go resolves it identically for the recipient.
  if (ctx.card.card_type === "prospect" && ctx.prospect && origin) {
    const minted = await mintAccessToken(db, {
      actionType: "prospect_schedule_call",
      prospectId: ctx.prospect.id,
      grantId: ctx.grant.id,
      createdBy: userId,
    });
    if (minted) alertData.schedulingUrl = `${origin}/go/${minted.rawToken}`;
  }

  const pdf = await renderAlertPdf(alertData);

  // CLIENT alerts get the short facts body; PROSPECT (cold-outreach) alerts get
  // the salutation + sender-named intro + credential block + scheduling CTA. The
  // sender's first name is resolved from the draft creator's profile at draft time
  // (draft creator == sender under preview == sent), null-safe to a name-less intro.
  let emailBody: string;
  if (ctx.card.card_type === "prospect") {
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
  return data;
}

// Reuse the existing draft if present; otherwise generate one. `origin` is the
// stable base URL for the baked-in booking link (only used when generating).
export async function getOrCreateDraftAlert(ctx: AlertContext, userId: string | null, origin: string): Promise<GrantAlertRow> {
  return (await getDraftAlert(ctx.card.id)) ?? generateDraftAlert(ctx, userId, origin);
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
