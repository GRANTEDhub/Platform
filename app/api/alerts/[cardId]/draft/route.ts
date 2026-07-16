import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";
import { loadAlertContext, alertRecipient } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, generateDraftAlert } from "@/lib/alerts/store";
import { getPriorAlertForEmail } from "@/lib/alerts/sent-status";

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

async function draftPayload(ctx: NonNullable<Awaited<ReturnType<typeof loadAlertContext>>>, alert: { id: string; subject: string | null; email_body: string | null }) {
  const recipient = alertRecipient(ctx);
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
    priorEmailedAt: (await getPriorAlertForEmail(recipient.email, ctx.card.id))?.sentAt ?? null,
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
