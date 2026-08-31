import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getConversation, updateConversationTitle } from "@/lib/grantbot/store";

// Rename a GrantBot conversation. STAFF ONLY, like the context and turn routes it sits beside.
//
// This is the "a policy plus a route" half of 0080's rename note -- and it turns out to be just a
// route: the write runs on the service-role client (which bypasses RLS), so no new UPDATE policy is
// needed, exactly as touchConversation already updates last_message_at with no policy. The rename
// edits only the conversation TITLE (metadata); it never touches grantbot_messages, so the
// append-only-transcript invariant is intact -- a stored answer still cannot be rewritten through
// any route.
//
// SAME PER-CLIENT MISLABEL GUARD AS THE CONTEXT ROUTE. Staff can rename any client's thread, so a
// (conversationId, clientId) mismatch is not a leak -- but it would let one org's page relabel
// another org's thread, which the panel's whole claim ("scoped to the client whose page you are
// on") forbids. So the rename is accepted only under the client the conversation actually belongs
// to.
export async function POST(req: NextRequest) {
  // getProfile returns the STAFF profile or null; a portal member has no profiles row. Same gate as
  // the context/turn routes, and not requireUser (which redirects, turning an auth failure on a
  // fetch into opaque HTML the panel cannot report).
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { clientId?: unknown; conversationId?: unknown; title?: unknown }
    | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
  const title = typeof body?.title === "string" ? body.title : "";
  if (!clientId || !conversationId) {
    return NextResponse.json(
      { error: "clientId and conversationId are required" },
      { status: 400 },
    );
  }
  if (!title.trim()) {
    return NextResponse.json({ error: "A title is required" }, { status: 400 });
  }

  const db = createServiceClient();
  const existing = await getConversation(db, conversationId);
  if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  if (existing.clientId !== clientId) {
    return NextResponse.json(
      { error: "That conversation belongs to a different client." },
      { status: 400 },
    );
  }

  const ok = await updateConversationTitle(db, { conversationId, clientId, title });
  if (!ok) return NextResponse.json({ error: "Rename failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
