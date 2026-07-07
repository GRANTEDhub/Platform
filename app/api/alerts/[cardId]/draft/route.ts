import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAlertContext } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, generateDraftAlert } from "@/lib/alerts/store";

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

function draftPayload(ctx: NonNullable<Awaited<ReturnType<typeof loadAlertContext>>>, alert: { id: string; subject: string | null; email_body: string | null }) {
  return {
    alertId: alert.id,
    to: ctx.client?.primary_contact_email ?? "",
    subject: alert.subject ?? `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`,
    body: alert.email_body ?? "",
  };
}

export async function GET(_req: Request, { params }: { params: { cardId: string } }) {
  const c = await adminCtx(params.cardId);
  if ("error" in c) return c.error;
  try {
    const alert = await getOrCreateDraftAlert(c.ctx, c.user.id);
    return NextResponse.json(draftPayload(c.ctx, alert));
  } catch (err) {
    return NextResponse.json(
      { error: `Draft generation failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}

export async function POST(_req: Request, { params }: { params: { cardId: string } }) {
  const c = await adminCtx(params.cardId);
  if ("error" in c) return c.error;
  try {
    const alert = await generateDraftAlert(c.ctx, c.user.id);
    return NextResponse.json(draftPayload(c.ctx, alert));
  } catch (err) {
    return NextResponse.json(
      { error: `Regeneration failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
