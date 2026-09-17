import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { conversationTitle, getFocusGrantId } from "@/lib/grantbot/store";
import { createFirmConversation, getFirmConversation } from "@/lib/grantbot/firm-store";
import { firmGrantbotEnabled, runFirmTurn, MAX_MESSAGE_CHARS } from "@/lib/grantbot/firm-turn";
import { grantbotAskFromProspectingEnabled } from "@/lib/grantbot/firm-ask-intent";

// One FIRM GrantBot turn. STAFF (admin-only), read-only, roster-wide, PERSISTED (Memory / Brick 2).
//
// maxDuration: one model call bounded at CALL_TIMEOUT_MS (120s), plus the roster query and the store
// writes. 300 leaves ample headroom.
export const maxDuration = 300;

// ── THE BODY IS message AND conversationId. NOTHING ELSE REACHES THE PROMPT. ──
//
// The transcript now lives in the STORE, keyed by conversationId — it is NOT posted from the browser
// anymore (that would let a client forge prior turns). The system prompt, guardrails and roster are
// assembled server-side from firm-prompt.ts. conversationId names which firm thread to continue;
// omit it to start a new one.
export async function POST(req: NextRequest) {
  // Flag-gated: 404 when off, so the surface is undiscoverable until GRANTBOT_FIRM_ENABLED is flipped.
  if (!firmGrantbotEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // getProfile, not requireAdmin: requireAdmin REDIRECTS, which on a fetch turns an auth failure into
  // opaque HTML the page cannot report. Admin-only — the roster aggregates every client's profile.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  let body: { message?: unknown; conversationId?: unknown; focusGrantId?: unknown; focusGrantTitle?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // The grant anchor (Ask GrantBot from the prospecting page). Honoured ONLY when
  // GRANTBOT_ASK_FROM_PROSPECTING_ENABLED is on, so a body that sends these while the flag is off is
  // ignored and the turn is byte-identical to before. The id is a POINTER used at create time to store
  // the anchor on the firm conversation row; the title is only ever the thread's display name; the
  // grounding text the model reads is composed server-side from the grant's own row + surfaced prospects
  // (firm-focus.ts), never from these fields — so no client-supplied text reaches the prompt.
  const askEnabled = grantbotAskFromProspectingEnabled();
  const focusGrantId = askEnabled && typeof body.focusGrantId === "string" ? body.focusGrantId : "";
  const focusGrantTitle = askEnabled && typeof body.focusGrantTitle === "string" ? body.focusGrantTitle : "";
  // Length is validated HERE, before any conversation is created — a 4xx with no conversationId, so
  // nothing is stored and the page restores the draft. Deferring this to runFirmTurn (which also
  // guards it) would first create an empty thread and then return 200 + { conversationId }, which the
  // page mistakes for a persisted turn (Codex): it would keep the bubble over an empty stored thread.
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message is too long (${message.length} characters, max ${MAX_MESSAGE_CHARS}).` },
      { status: 400 },
    );
  }

  const db = createServiceClient();

  // Create on the first turn, reuse after. getFirmConversation filters scope='firm', so a client
  // conversation id (or a stale/deleted one) resolves to nothing and 404s rather than appending a
  // firm turn onto a client's thread. Everything past this line is PERSISTED, so a subsequent model
  // failure returns 200 + { conversationId, error } (not a 4xx) — the page keeps its bubble and
  // continues the same thread, matching the recorded turn.
  // The STORED anchor to ground this turn on. Resolved server-side: on create it is the just-stored id;
  // on an existing thread it is read back from the conversation row (getFocusGrantId, flag-gated +
  // fail-soft), so a browser cannot re-anchor a thread mid-conversation. Null on the flag-off path
  // (byte-identical). getFocusGrantId is conversationId-scoped (not client-gated); the row here is already
  // known to be a firm thread (getFirmConversation filtered scope='firm'), so reusing it is safe.
  let focusForTurn: string | null = null;
  let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  if (conversationId) {
    const existing = await getFirmConversation(db, conversationId);
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    if (askEnabled) focusForTurn = await getFocusGrantId(db, conversationId);
  } else {
    const created = await createFirmConversation(db, {
      // A firm thread opened from a grant's prospecting page is auto-named after the grant (so the rail
      // reads as "this grant" and the staffer finds it later); otherwise the usual first-message title.
      title: focusGrantId && focusGrantTitle ? conversationTitle(focusGrantTitle) : conversationTitle(message),
      startedBy: profile.id,
      startedByEmail: profile.email ?? null,
      focusGrantId: focusGrantId || null,
    });
    if (!created) return NextResponse.json({ error: "Could not start a conversation" }, { status: 500 });
    conversationId = created.id;
    focusForTurn = focusGrantId || null;
  }

  const outcome = await runFirmTurn({
    db,
    conversationId,
    message,
    generatedBy: profile.email ?? "unknown",
    actorRole: "admin",
    // The grant anchor for this turn (from the stored conversation, never the raw body) — see the note
    // above. runFirmTurn composes the grant+prospects grounding block from the grant's own row; null → none.
    focusGrantId: focusForTurn,
  });

  if (!outcome.ok) {
    if (!outcome.persisted) {
      // Nothing was stored (the user-row insert failed — a transient fault or a concurrent same-thread
      // seq collision). Return WITHOUT a conversationId so the page RESTORES the draft for a clean retry
      // rather than keeping an optimistic bubble over an empty thread: the page treats a 200 + error +
      // conversationId as a persisted turn (Codex #542).
      return NextResponse.json({ error: outcome.message }, { status: 200 });
    }
    // 200 with an error field AND the conversation id: the turn WAS recorded (a failed turn is still a
    // turn — the user row plus an assistant-error row), so the page keeps the optimistic bubble (it
    // matches the store) and continues this thread.
    return NextResponse.json({ conversationId, error: outcome.message }, { status: 200 });
  }
  return NextResponse.json({ conversationId, text: outcome.text, usage: outcome.usage });
}
