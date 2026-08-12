import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getConversation, listConversations, loadMessages } from "@/lib/grantbot/store";

// The read half of GrantBot. STAFF ONLY, like the turn route it sits beside.
//
// ── WHY A READ ROUTE EXISTS AT ALL ──
//
// The full page assembles its own transcript server-side and always will. This is for the corner
// launcher, which mounts on the client dashboard: that page cannot pay for a transcript on every
// load for a panel most visits never open, and a client-side <Link> or a bubble click has no way
// to ask a server component for data. So the panel opens, then asks.
//
// ── WHAT IT DELIBERATELY DOES NOT RETURN ──
//
// The context pack. The full page builds one to report the prompt's SIZE and version stamps
// before the first question, which costs seven queries; the corner panel shows no such read-out,
// so it does not pay for one. That keeps opening the bubble two queries, not nine, and it is why
// the pack's cost argument survives the launcher. The turn route still assembles the real pack at
// send time -- nothing about the answer changes, only what the panel says about itself.
export async function GET(req: NextRequest) {
  // getProfile returns the STAFF profile or null (a portal member has no profiles row), so this
  // is the same gate as the turn route. Not requireUser: that REDIRECTS, which on a fetch turns
  // an auth failure into opaque HTML the panel cannot report.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  const requested = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });

  const db = createServiceClient();
  const conversations = await listConversations(db, clientId);

  // WHICH THREAD, and the client check on it. Staff can read every client's threads, so a
  // mismatch here is not a leak -- it is a mislabel, which is worse in its own way: a transcript
  // about one organisation rendered under another organisation's name, in a panel whose entire
  // claim is that it is scoped to the client whose page you are on.
  let active: string | null = null;
  if (requested) {
    const existing = await getConversation(db, requested);
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    if (existing.clientId !== clientId) {
      return NextResponse.json(
        { error: "That conversation belongs to a different client." },
        { status: 400 },
      );
    }
    active = existing.id;
  } else {
    active = conversations[0]?.id ?? null;
  }

  const messages = active ? await loadMessages(db, active) : [];

  return NextResponse.json({
    conversationId: active,
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      lastMessageAt: c.lastMessageAt,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.content.map((c) => c.text).join("\n"),
      error: m.error,
      usage: m.usage,
      instructionsVersion: m.instructionsVersion,
      methodologyVersion: m.methodologyVersion,
    })),
  });
}
