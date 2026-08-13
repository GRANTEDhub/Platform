import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getArtifactHtmlForClient } from "@/lib/grantbot/artifacts-store";
import { sanitizeDocument } from "@/lib/sanitize/html";
import { artifactStandaloneHtml, artifactFilename } from "@/lib/grantbot/artifact-html";

// HTML export (Brick 1a): download the artifact's source as a self-contained .html file. STAFF ONLY.
// The current version by default, or ?version=N for a specific one. PDF/.docx exports are 1b.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  const versionParam = req.nextUrl.searchParams.get("version");
  const version = versionParam ? Number(versionParam) : undefined;

  const db = createServiceClient();
  const got = await getArtifactHtmlForClient(db, { artifactId: id, clientId, version });
  if (!got) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });

  const doc = artifactStandaloneHtml(got.title, sanitizeDocument(got.html));
  return new NextResponse(doc, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${artifactFilename(got.title)}"`,
    },
  });
}
