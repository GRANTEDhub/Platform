import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { firmGrantbotEnabled, runFirmTurn, type FirmTurnMessage } from "@/lib/grantbot/firm-turn";

// One FIRM GrantBot turn. STAFF (admin-only in Brick 1), read-only, roster-wide, EPHEMERAL.
//
// maxDuration: one model call bounded at CALL_TIMEOUT_MS (120s) plus the single roster query. 300
// leaves ample headroom.
export const maxDuration = 300;

// ── THE BODY IS message AND history. NOTHING ELSE REACHES THE PROMPT. ──
//
// history is the running transcript the page holds (ephemeral — nothing is stored server-side, so
// there is nothing to read back). It contains only prior turns of THIS conversation; the system
// prompt, guardrails and roster are all assembled server-side from firm-prompt.ts, never from the
// body. A browser cannot inject a system instruction here.
export async function POST(req: NextRequest) {
  // Flag-gated: 404 when off, so the surface is not even discoverable until GRANTBOT_FIRM_ENABLED is
  // flipped + redeployed.
  if (!firmGrantbotEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // getProfile, not requireAdmin: requireAdmin REDIRECTS, which on a fetch turns an auth failure into
  // an opaque HTML response the page cannot report. Admin-only in Brick 1 — the roster aggregates
  // every client's internal profile, a broader exposure than a contractor's per-client access.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  let body: { message?: unknown; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Sanitise the supplied transcript into {role, text} turns; drop anything malformed rather than
  // trusting the shape. Only two roles exist; anything else is coerced to "user" (harmless — it is
  // just prior context, not an instruction channel).
  const history: FirmTurnMessage[] = Array.isArray(body.history)
    ? body.history
        .map((m): FirmTurnMessage | null => {
          const o = m as { role?: unknown; text?: unknown } | null;
          const text = typeof o?.text === "string" ? o.text : "";
          if (!text.trim()) return null;
          return { role: o?.role === "assistant" ? "assistant" : "user", text };
        })
        .filter((m): m is FirmTurnMessage => m !== null)
    : [];

  const outcome = await runFirmTurn({
    history,
    message,
    generatedBy: profile.email ?? "unknown",
    actorRole: "admin",
  });

  if (!outcome.ok) {
    // 200 with an error field, not a 5xx: the page keeps the transcript it already holds and shows
    // the reason inline, rather than treating a model hiccup as a lost conversation.
    return NextResponse.json({ error: outcome.message }, { status: 200 });
  }
  return NextResponse.json({ text: outcome.text, usage: outcome.usage });
}
