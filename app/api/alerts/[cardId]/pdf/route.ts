import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAlertContext, renderAlertPdfForCard, debugAlertFontsForCard } from "@/lib/alerts/generate";

// The isolated Chromium route: renders the branded alert PDF for preview (opened
// in a new tab from the send modal). @sparticuz/chromium loads only here (and in
// the send route). Node runtime + a longer budget for cold start + render.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { cardId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const ctx = await loadAlertContext(params.cardId);
  if (!ctx) return NextResponse.json({ error: "Card or grant not found" }, { status: 404 });

  // ?debug=fonts: confirm on the live function that the TTFs shipped + apply.
  if (new URL(req.url).searchParams.get("debug") === "fonts") {
    try {
      return NextResponse.json(await debugAlertFontsForCard(ctx));
    } catch (err) {
      return NextResponse.json(
        { error: `Font debug failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
  }

  try {
    const pdf = await renderAlertPdfForCard(ctx);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="grant-alert.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Render failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
