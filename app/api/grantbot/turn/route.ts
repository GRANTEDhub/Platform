import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { conversationTitle, createConversation, getConversation } from "@/lib/grantbot/store";
import { runTurn } from "@/lib/grantbot/turn";

// One GrantBot turn. STAFF ONLY, read-only, one client per conversation.
//
// maxDuration: the model call is bounded at 120s in runTurn, and the pack that precedes it runs
// seven queries. 300 leaves headroom for a slow pack plus a slow answer rather than truncating an
// answer the staffer already waited for.
export const maxDuration = 300;

// ── THE BODY IS message AND pasted. NOTHING ELSE REACHES THE PROMPT. ──
//
// runTurn accepts `turnBlocks` for a future skill-retrieval step, and this route deliberately does
// NOT read them from the request. A browser-supplied prompt block is a browser-supplied system
// prompt: the guardrails, the org rules and the read-only statement are all text, and text that
// arrives from the client can replace them. When retrieval ships, the blocks get selected here on
// the server from the client id and the message -- never parsed out of the body.
export async function POST(req: NextRequest) {
  // getProfile, not requireUser: requireUser REDIRECTS, which on a fetch turns an auth failure
  // into an opaque HTML response the panel cannot report.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { clientId?: unknown; conversationId?: unknown; message?: unknown; pasted?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const message = typeof body.message === "string" ? body.message : "";
  if (!clientId || !message.trim()) {
    return NextResponse.json({ error: "clientId and message are required" }, { status: 400 });
  }

  const pastedRaw = body.pasted as { body?: unknown; describedAs?: unknown } | null | undefined;
  const pasted =
    pastedRaw && typeof pastedRaw.body === "string" && pastedRaw.body.trim()
      ? {
          body: pastedRaw.body,
          describedAs: typeof pastedRaw.describedAs === "string" ? pastedRaw.describedAs : undefined,
        }
      : null;

  const db = createServiceClient();

  // A conversation is created on the first turn and reused after. Its client_id is authoritative:
  // a conversation cannot be moved to another client mid-thread, because every earlier answer in
  // it was produced from a different organisation's facts.
  let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  if (conversationId) {
    const existing = await getConversation(db, conversationId);
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    if (existing.clientId !== clientId) {
      return NextResponse.json(
        { error: "That conversation belongs to a different client." },
        { status: 400 },
      );
    }
  } else {
    const created = await createConversation(db, {
      clientId,
      title: conversationTitle(message),
      startedBy: profile.id,
      startedByEmail: profile.email ?? null,
    });
    if (!created) return NextResponse.json({ error: "Could not start a conversation" }, { status: 500 });
    conversationId = created.id;
  }

  const outcome = await runTurn({
    db,
    clientId,
    conversationId,
    message,
    pasted,
    actorEmail: profile.email ?? "unknown",
    actorRole: profile.role === "admin" ? "admin" : "contractor",
    // turnBlocks intentionally omitted -- see the header. Nothing produces them yet, and when
    // something does, it will be selected here rather than accepted from the caller.
  });

  if (!outcome.ok) {
    // 200 WITH AN ERROR FIELD, not a 5xx: the turn was recorded either way (a failed turn is
    // still a turn), and the panel needs the conversation id back so the next message continues
    // the same thread rather than silently starting a new one after every hiccup.
    return NextResponse.json({ conversationId, error: outcome.message }, { status: 200 });
  }

  return NextResponse.json({
    conversationId,
    text: outcome.text,
    usage: outcome.usage,
  });
}
