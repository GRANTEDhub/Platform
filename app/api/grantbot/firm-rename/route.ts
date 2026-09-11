import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { getFirmConversation, updateFirmConversationTitle } from "@/lib/grantbot/firm-store";

// Rename a FIRM GrantBot conversation. STAFF (admin-only), flag-gated, like the firm turn / context
// routes it sits beside. The per-client sibling is /api/grantbot/rename; this one carries NO clientId
// — a firm thread has none — and the boundary is scope='firm', not client_id.
//
// Like the per-client rename, this is 0080's "a policy plus a route" note and it is just a route: the
// write runs on the service-role client (which bypasses RLS), so no new UPDATE policy is needed. The
// rename edits only the conversation TITLE (metadata); it never touches grantbot_messages, so the
// append-only-transcript invariant holds — a stored answer still cannot be rewritten through any route.
//
// getFirmConversation and updateFirmConversationTitle both filter scope='firm', so a client-thread id
// (or a stale/deleted one) 404s and updates zero rows rather than relabeling a client's thread through
// the firm surface — the same defence-in-depth the per-client route gets from its clientId mislabel guard.
export async function POST(req: NextRequest) {
  // Flag-gated: 404 when off, so the whole firm surface stays undiscoverable until GRANTBOT_FIRM_ENABLED
  // is flipped + redeployed, matching the firm turn/context routes.
  if (!firmGrantbotEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // getProfile, not requireAdmin: requireAdmin REDIRECTS, which on a fetch turns an auth failure into
  // opaque HTML the page cannot report. Admin-only, like the other firm routes.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as
    | { conversationId?: unknown; title?: unknown }
    | null;
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
  const title = typeof body?.title === "string" ? body.title : "";
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  if (!title.trim()) {
    return NextResponse.json({ error: "A title is required" }, { status: 400 });
  }

  const db = createServiceClient();
  // Resolve under scope='firm' first: a client-thread id (or a gone one) is a 404 here, so the update
  // below never even runs on a non-firm row.
  const existing = await getFirmConversation(db, conversationId);
  if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const ok = await updateFirmConversationTitle(db, { conversationId, title });
  if (!ok) return NextResponse.json({ error: "Rename failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
