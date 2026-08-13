import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { grantbotArtifactsEnabled } from "@/lib/grantbot/artifacts";
import { exportArtifact, isExportFormat } from "@/lib/grantbot/artifact-export";

// Rendered exports (Brick 1b): download the artifact's current (or ?version=N) HTML as a PDF or a
// real .docx. STAFF ONLY. The 1a .html download lives at ../html; this route adds the two rendered
// formats via the shared cache-keyed scaffold, then 302s to a short-lived signed URL that downloads
// the file directly from the private bucket.
//
// Chromium (PDF) needs the node runtime and the alert routes' 60s budget; force-dynamic so the flag
// and auth are read per request.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // Flag-gated, unlike the 1a reads: these formats are RENDERED (Chromium + html-to-docx) and only
  // exist when artifacts are on. The panel only shows the buttons under the same flag, so this is the
  // server-side half of "the export buttons only render/function when the flag's on".
  if (!grantbotArtifactsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  const format = req.nextUrl.searchParams.get("format") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (!isExportFormat(format)) return NextResponse.json({ error: "format must be pdf or docx" }, { status: 400 });
  const versionParam = req.nextUrl.searchParams.get("version");
  const version = versionParam ? Number(versionParam) : undefined;

  const db = createServiceClient();
  try {
    const out = await exportArtifact(db, { artifactId: id, clientId, version, format });
    if (!out) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    // 302 to the signed URL (content-disposition: attachment via the download option) -> same
    // one-click download UX as the 1a "Download HTML" <a>.
    return NextResponse.redirect(out.signedUrl);
  } catch (err) {
    return NextResponse.json(
      { error: `Export failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
