import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mergePreparedBatchPdf } from "@/lib/alerts/batch-send";

// Preview the MERGED batch PDF for the send modal's attachment link -- streams the
// exact artifact send-batch would attach (the selected cards' saved drafts, merged
// in deadline order), with no state change. GET so it opens in a new tab; cardIds
// come as a comma-separated query param. Requires prepared drafts (the modal only
// shows this link after the prepare loop reports done).
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const cardIds = (req.nextUrl.searchParams.get("cardIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const merged = await mergePreparedBatchPdf(params.id, cardIds);
  if ("error" in merged) return NextResponse.json({ error: merged.error }, { status: merged.status });

  return new NextResponse(new Uint8Array(merged.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="grant-alerts.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
