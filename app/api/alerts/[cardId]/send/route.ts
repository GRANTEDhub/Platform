import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantAlertEmail, isDeliverableEmail } from "@/lib/email/send";
import { loadAlertContext, renderAlertPdfForCard } from "@/lib/alerts/generate";
import { buildAlertEmailBody } from "@/lib/alerts/data";

// Confirm-send: render the alert PDF and send it to the client with the short
// text body attached. Routes through the same recipient-aware gate as every other
// send (canSendOutreach = canSendEmail + isRecipientAllowed) -- on preview or when
// the allowlist blocks the recipient, NOTHING sends and no state changes. On a
// real send, stamp sent_at/sent_to on the card (same as the approve-send).
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { cardId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { to?: string; subject?: string; body?: string };

  const ctx = await loadAlertContext(params.cardId);
  if (!ctx) return NextResponse.json({ error: "Card or grant not found" }, { status: 404 });

  const recipient = (body.to ?? ctx.client?.primary_contact_email ?? "").trim();
  if (!isDeliverableEmail(recipient)) {
    return NextResponse.json({ error: "Add a valid recipient email before sending." }, { status: 400 });
  }

  // Gate first: on preview / disabled / allowlist-blocked, no render, no send, no
  // state change -- report the reason.
  const gate = canSendOutreach(recipient);
  if (!gate.ok) return NextResponse.json({ sent: false, reason: gate.reason });

  let pdf: Buffer;
  try {
    pdf = await renderAlertPdfForCard(ctx);
  } catch (err) {
    return NextResponse.json(
      { sent: false, error: `Render failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const subject = (body.subject ?? "").trim() || `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`;
  const emailBody = (body.body ?? "").trim() || buildAlertEmailBody(ctx.grant, ctx.card);

  try {
    const sent = await sendGrantAlertEmail({ to: recipient, subject, body: emailBody, pdf });
    const db = createServiceClient();
    await db.from("review_cards").update({ sent_at: new Date().toISOString(), sent_to: sent.to }).eq("id", params.cardId);
    return NextResponse.json({ sent: true, to: sent.to });
  } catch (err) {
    return NextResponse.json(
      { sent: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
