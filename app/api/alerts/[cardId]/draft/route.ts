import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAlertContext } from "@/lib/alerts/generate";
import { buildAlertEmailBody } from "@/lib/alerts/data";

// Fast, deterministic draft for the send modal: recipient + subject + short text
// body (facts only, no LLM, no render). The PDF is fetched separately from ./pdf.
export async function GET(_req: Request, { params }: { params: { cardId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const ctx = await loadAlertContext(params.cardId);
  if (!ctx) return NextResponse.json({ error: "Card or grant not found" }, { status: 404 });

  return NextResponse.json({
    to: ctx.client?.primary_contact_email ?? "",
    subject: `GRANTED Alert: ${ctx.grant.title || "New grant opportunity"}`,
    body: buildAlertEmailBody(ctx.grant, ctx.card),
  });
}
