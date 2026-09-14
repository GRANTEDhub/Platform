import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { conversationTitle, createConversation, getConversation, getFocusGrantId } from "@/lib/grantbot/store";
import { runTurn } from "@/lib/grantbot/turn";
import { validateTurnImage } from "@/lib/grantbot/vision";
import { grantbotAskFromReviewEnabled } from "@/lib/grantbot/ask-intent";

// One GrantBot turn. STAFF ONLY, read-only, one client per conversation.
//
// maxDuration: the model call(s) are bounded in aggregate at TURN_DEADLINE_MS (220s) by runTurn's
// runToolLoop -- up to four sequential calls when a tool flag is on (<=PER_CLIENT_MAX_TOOL_ROUNDS=3
// tool rounds + a forced final answer), one call otherwise -- and the pack that precedes them runs
// seven queries. 300 leaves ~80s of headroom over the 220s deadline for a slow pack plus the store
// writes rather than truncating an answer the staffer already waited for.
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

  let body: {
    clientId?: unknown;
    conversationId?: unknown;
    message?: unknown;
    pasted?: unknown;
    image?: unknown;
    focusGrantId?: unknown;
    focusGrantTitle?: unknown;
  };
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

  // The grant anchor (Ask GrantBot from a grant card). Honoured ONLY when the flag is on, so a body
  // that sends these while the flag is off is ignored and the turn is byte-identical to before. The
  // grant ID is a POINTER used at create time to store the anchor; the grant TITLE is only ever the
  // thread's display name (whitespace-collapsed + capped by conversationTitle, like a rename), and the
  // grounding text the model reads is composed server-side from the grant's own row (see focus-grant.ts),
  // never from these fields — so no client-supplied text reaches the prompt.
  const askEnabled = grantbotAskFromReviewEnabled();
  const focusGrantId = askEnabled && typeof body.focusGrantId === "string" ? body.focusGrantId : "";
  const focusGrantTitle = askEnabled && typeof body.focusGrantTitle === "string" ? body.focusGrantTitle : "";

  const pastedRaw = body.pasted as { body?: unknown; describedAs?: unknown } | null | undefined;
  const pasted =
    pastedRaw && typeof pastedRaw.body === "string" && pastedRaw.body.trim()
      ? {
          body: pastedRaw.body,
          describedAs: typeof pastedRaw.describedAs === "string" ? pastedRaw.describedAs : undefined,
        }
      : null;

  // One optional per-turn image (vision). validateTurnImage never throws — a malformed / oversized /
  // disallowed-type payload becomes null and the turn proceeds text-only. runTurn additionally drops it
  // unless GRANTBOT_VISION_ENABLED is on, so an image sent while the flag is off has no effect.
  const image = validateTurnImage(body.image);

  const db = createServiceClient();

  // A conversation is created on the first turn and reused after. Its client_id is authoritative:
  // a conversation cannot be moved to another client mid-thread, because every earlier answer in
  // it was produced from a different organisation's facts.
  // The STORED anchor to ground this turn on. Resolved server-side: on create it is the just-stored id;
  // on an existing thread it is read back from the row (getFocusGrantId, flag-gated + fail-soft), so a
  // browser cannot re-anchor a thread mid-conversation. Null on the flag-off path (byte-identical).
  let focusForTurn: string | null = null;
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
    if (askEnabled) focusForTurn = await getFocusGrantId(db, conversationId);
  } else {
    const created = await createConversation(db, {
      clientId,
      // A thread opened from a grant card is auto-named after the grant (so the staffer finds it later
      // and the rail reads as "this grant"); otherwise the usual first-message title.
      title: focusGrantId && focusGrantTitle ? conversationTitle(focusGrantTitle) : conversationTitle(message),
      startedBy: profile.id,
      startedByEmail: profile.email ?? null,
      focusGrantId: focusGrantId || null,
    });
    if (!created) return NextResponse.json({ error: "Could not start a conversation" }, { status: 500 });
    conversationId = created.id;
    focusForTurn = focusGrantId || null;
  }

  const outcome = await runTurn({
    db,
    clientId,
    conversationId,
    message,
    pasted,
    image,
    actorEmail: profile.email ?? "unknown",
    actorRole: profile.role === "admin" ? "admin" : "contractor",
    // The grant anchor for this turn (from the stored conversation, never the raw body) — see the note
    // above. runTurn composes the grounding block from the grant's own row; null → no block.
    focusGrantId: focusForTurn,
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
