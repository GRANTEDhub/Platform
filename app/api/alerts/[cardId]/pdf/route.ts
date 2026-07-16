import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";
import { loadAlertContext } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, assembleOutwardAlertPdf } from "@/lib/alerts/store";

// Preview the SAVED draft PDF (opened in a new tab from the send modal). Streams
// the stored artifact from the private bucket -- no re-render -- so the preview is
// byte-for-byte the file that will be sent. Falls back to generating the draft if
// one doesn't exist yet (direct hit before the modal created it).
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

  try {
    // withHorizon: single-send preview -> compute/freeze + concatenate the forecast
    // horizon page so the previewed PDF is byte-for-byte what the single send attaches.
    const alert = await getOrCreateDraftAlert(ctx, user.id, appBaseUrl(req), { withHorizon: true });
    const pdf = await assembleOutwardAlertPdf(alert);
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
      { error: `Preview failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
