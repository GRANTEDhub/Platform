import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { listArtifacts, getArtifact } from "@/lib/grantbot/artifacts-store";
import { sanitizeDocument } from "@/lib/sanitize/html";

// The read half of GrantBot document artifacts (Brick 1a). STAFF ONLY, like the turn and context
// routes it sits beside. The panel opens, then asks: ?clientId=<id> returns the client's artifact
// list; adding &artifactId=<id> returns that artifact's current HTML + version history for the
// preview pane. The turn route is what WRITES artifacts (behind the flag); this only reads.
//
// Reads are flag-INDEPENDENT: when GRANTBOT_ARTIFACTS_ENABLED is off nothing was ever created, so the
// list is simply empty -- no need to gate the read.
export async function GET(req: NextRequest) {
  // Same gate as the context/turn routes: getProfile is the STAFF profile or null. Not requireUser
  // (which redirects, turning an auth failure into opaque HTML a fetch cannot report).
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  const artifactId = req.nextUrl.searchParams.get("artifactId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });

  const db = createServiceClient();

  if (artifactId) {
    const detail = await getArtifact(db, artifactId, clientId);
    if (!detail) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    // Sanitise on read too: the stored html was sanitised on write, but the panel hands this to
    // dangerouslySetInnerHTML, so re-running the DOCUMENT profile makes what reaches innerHTML clean
    // regardless of how the row got there. Idempotent on already-sanitised content.
    return NextResponse.json({ artifact: { ...detail, html: sanitizeDocument(detail.html) } });
  }

  const artifacts = await listArtifacts(db, clientId);
  return NextResponse.json({ artifacts });
}
