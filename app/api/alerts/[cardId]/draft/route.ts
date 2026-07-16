import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";
import { loadAlertContext, alertRecipient } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, generateDraftAlert, type GrantAlertRow } from "@/lib/alerts/store";
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
  if (profile?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  const ctx = await loadAlertContext(cardId);
  if (!ctx) return { error: NextResponse.json({ error: "Card or grant not found" }, { status: 404 }) };
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
    const alert = await getOrCreateDraftAlert(c.ctx, c.user.id, appBaseUrl(req));
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
    const alert = await generateDraftAlert(c.ctx, c.user.id, appBaseUrl(req));
    return NextResponse.json(await draftPayload(c.ctx, alert));
  } catch (err) {
    return NextResponse.json(
      { error: `Regeneration failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
