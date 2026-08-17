import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";
import { loadAlertContext, alertRecipient } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, generateDraftAlert, ensureDecisionLinks, type GrantAlertRow } from "@/lib/alerts/store";
import { getPriorAlertForEmail } from "@/lib/alerts/sent-status";
import { buildProspectEmailBody } from "@/lib/alerts/data";

// The alert draft is a PERSISTED artifact (grant_alerts): generate once, reuse
// for preview AND send so the previewed PDF is byte-for-byte what goes out.
//   GET  -> reuse the card's existing draft, or generate + save one if none.
//   POST -> "Regenerate": force a fresh draft (replaces the saved one + its PDF).
// Both return the recipient + saved subject/body for the send modal. Rendering
// happens in the store (enrich + Chromium), so allow the longer budget.
export const runtime = "nodejs";
export const maxDuration = 60;

async function adminCtx(cardId: string) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile) return { error: NextResponse.json({ error: "Staff only" }, { status: 403 }) };
  const ctx = await loadAlertContext(cardId);
  if (!ctx) return { error: NextResponse.json({ error: "Card or grant not found" }, { status: 404 }) };
  // BizDev boundary: a COLD prospect/lead draft is admin-only (matches the send
  // route). Warm client drafts are open to any staff (the AM).
  if ((ctx.card.card_type === "prospect" || ctx.isLead) && profile.role !== "admin") {
    return { error: NextResponse.json({ error: "Prospect/lead outreach is admin-only" }, { status: 403 }) };
  }
  return { user, ctx };
}

async function draftPayload(ctx: NonNullable<Awaited<ReturnType<typeof loadAlertContext>>>, alert: GrantAlertRow) {
  const recipient = alertRecipient(ctx);
  // COLD send = a discovery prospect card OR a lead (Tara-build) client card. Only a
  // cold re-contact gets the send GATE (see the gate component); a warm client keeps
  // the passive "emailed before" note. Same predicate the send route forks on.
  const isColdSend = ctx.card.card_type === "prospect" || ctx.isLead;
  const prior = await getPriorAlertForEmail(recipient.email, ctx.card.id);
  return {
    alertId: alert.id,
    to: recipient.email,
    subject: alert.subject ?? `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`,
    body: alert.email_body ?? "",
    // Cold-outreach PDFs (a discovery prospect OR a lead / Tara-build prospect) carry
    // a clickable booking link (baked in at render) -- the modal hints the admin to it.
    schedulingLink: recipient.kind === "prospect" || ctx.isLead,
    // Soft "you've emailed this address before" flag for the To: field, computed for
    // the default recipient (re-hitting the same individual is what we want to catch).
    priorEmailedAt: prior?.sentAt ?? null,
    isColdSend,
    // Gate metadata for a COLD re-contact (we've emailed this address before):
    //  - priorCardId: link the gate to the prior send (/review/<cardId>).
    //  - followUpBody: the client-side swap when the sender chooses "switch to a
    //    follow-up" -- the cold body minus the first-contact intro AND credential
    //    (buildProspectEmailBody(followUp=true)), keeping the grant + booking CTA.
    //    Composed with the SAME hasSchedulingLink as the cold body so the PDF pointer
    //    matches; the follow-up intro carries no sender name (drops it), so it needs
    //    no sender resolution. Null for a warm client send (no follow-up variant).
    priorCardId: prior?.cardId ?? null,
    followUpBody: isColdSend
      ? buildProspectEmailBody(ctx.grant, ctx.card, null, !!alert.alert_data?.schedulingUrl, true)
      : null,
  };
}

export async function GET(req: Request, { params }: { params: { cardId: string } }) {
  const c = await adminCtx(params.cardId);
  if ("error" in c) return c.error;
  try {
    // withDecisionLinks (NOT withHorizon): wire the Interested / Not-for-us block into the
    // previewed body so the modal shows it and posts it back on an as-is send -- the box only
    // renders when the sent body carries the URLs. The horizon is a PDF-only cost the text
    // preview skips (the PDF preview route pays it separately).
    const alert = await getOrCreateDraftAlert(c.ctx, c.user.id, appBaseUrl(req), { withDecisionLinks: true });
    return NextResponse.json(await draftPayload(c.ctx, alert));
  } catch (err) {
    return NextResponse.json(
      { error: `Draft generation failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}

export async function POST(req: Request, { params }: { params: { cardId: string } }) {
  const c = await adminCtx(params.cardId);
  if ("error" in c) return c.error;
  try {
    // A fresh draft has no decision block; wire it back so the regenerated preview matches
    // what will be sent (same reason as GET). No-op for non-managed cards.
    const fresh = await generateDraftAlert(c.ctx, c.user.id, appBaseUrl(req));
    const alert = await ensureDecisionLinks(c.ctx, fresh, c.user.id, appBaseUrl(req));
    return NextResponse.json(await draftPayload(c.ctx, alert));
  } catch (err) {
    return NextResponse.json(
      { error: `Regeneration failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
