import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { loadMessages } from "@/lib/grantbot/store";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { getFirmConversation, listFirmConversations } from "@/lib/grantbot/firm-store";
import { toGrantBotMsg, toGrantBotThread } from "@/lib/grantbot/wire";

// The read half of the FIRM GrantBot (Memory / Brick 2): the thread rail, and one thread's
// transcript. STAFF (admin-only), like the firm turn route beside it. There is no clientId — a firm
// thread is firm-wide, so this lists scope='firm' threads and loads them by id.
//
// Mirrors the per-client context route: `threadsOnly=1` returns just the rail (the page refetches it
// after every send to re-sort), otherwise it returns the requested (or most-recent) transcript.
export async function GET(req: NextRequest) {
  // Flag-gated to 404 when off, like the firm turn route and page — the whole firm surface stays
  // undiscoverable until GRANTBOT_FIRM_ENABLED is flipped + redeployed.
  if (!firmGrantbotEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const requested = req.nextUrl.searchParams.get("conversationId") ?? "";
  const threadsOnly = req.nextUrl.searchParams.get("threadsOnly") === "1";

  const db = createServiceClient();
  const conversations = await listFirmConversations(db);

  if (threadsOnly) {
    return NextResponse.json({ conversations: conversations.map(toGrantBotThread) });
  }

  // Which thread. getFirmConversation filters scope='firm', so a stale/deleted or non-firm id 404s
  // rather than silently loading nothing under a valid-looking response.
  let active: string | null = null;
  if (requested) {
    const existing = await getFirmConversation(db, requested);
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    active = existing.id;
  } else {
    active = conversations[0]?.id ?? null;
  }

  const messages = active ? await loadMessages(db, active) : [];

  return NextResponse.json({
    conversationId: active,
    conversations: conversations.map(toGrantBotThread),
    messages: messages.map(toGrantBotMsg),
  });
}
