// "Ask GrantBot about this grant" — the seam that lets a staffer, looking at one grant's IntellEngine
// tile, open a per-client GrantBot thread ANCHORED to that grant, so they can just ask ("is the deadline
// realistic?") without re-establishing which grant they mean (the MS County retyping this kills).
//
// WHAT IT DOES (v2 — the grant-scoped thread, migration 0098):
//   - The tile button stashes a GRANT ANCHOR (grantId + grantTitle) under askContextKey and opens the
//     corner GrantBot on this client at a NEW thread (the existing `/clients/<id>?grantbot=new` deep-link,
//     honoured by the Switcher / launcher). The chat reads-and-clears the anchor on mount.
//   - On the first send the turn route stores focus_grant_id on the conversation and AUTO-NAMES the
//     thread after the grant; every turn after is grounded on that grant server-side (focus-grant.ts),
//     so the bot knows the grant + client durably — even after a reload — with nothing retyped.
//   - The three starter questions (below) render as CLICKABLE CHIPS inside the new thread's empty state
//     (the chat), one-click to fill the composer; the staffer can also just type a free-form question
//     and it is still grant-scoped.
//
// The anchor is a POINTER (an id) + a display label (the title). The grounding text the model reads is
// composed server-side from the grant's own public row (focus-grant.ts), never from the client — so no
// browser-supplied prompt text reaches the model, the turn's standing invariant.
//
// FLAG-GATED, byte-identical OFF: the review page renders the button and the turn route honours the
// anchor only when GRANTBOT_ASK_FROM_REVIEW_ENABLED is on, so off is exactly today's page + turn.

import { BLANK_CONVERSATION, askContextKey, type AskContext } from "@/lib/grantbot/wire";

// Server-read flag (the review page gates the button on it; the turn route honours the anchor on it).
// Off unless exactly "true" — the same shape as the other GrantBot flags; never NEXT_PUBLIC_, so it is
// read server-side and the button is simply not rendered when off (no client bundle change, no affordance).
export function grantbotAskFromReviewEnabled(): boolean {
  return process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED === "true";
}

export interface AskStarter {
  // Stable id for the React key and tests.
  key: string;
  // The short pill label the staffer clicks.
  chip: string;
  // The full question the chip drops into the composer. It still NAMES the client and the grant — the
  // thread is already grounded server-side, so this is belt-and-suspenders (a robust question even if a
  // turn's grounding were weak) and reads naturally on its own.
  question: string;
}

// The three starter questions. Pure and exported so their shape/text is unit-tested (each names the
// client and the grant; the three are distinct and cover the who-wins / eligibility / deadline axes).
// Deliberately phrased as the questions a strategist would actually ask — not "is this a good fit?"
// but the specific decision inputs.
export function askStarters(clientName: string, grantTitle: string): AskStarter[] {
  const client = clientName.trim() || "this client";
  const grant = grantTitle.trim() || "this grant";
  return [
    {
      key: "who_wins",
      chip: "Who wins this?",
      question: `Who actually wins ${grant}? What applicant type or profile tends to get funded, and where would ${client} realistically sit against that field?`,
    },
    {
      key: "eligibility",
      chip: "Eligible? (prime vs sub)",
      question: `Is ${client} eligible for ${grant} — as a prime applicant, or only as a partner/sub? Be specific about the entity-type requirement and any registration gates.`,
    },
    {
      key: "deadline",
      chip: "Deadline realistic?",
      question: `Is the ${grant} deadline realistic for ${client} to pursue — factoring SAM/registration status and the level of effort a competitive application needs?`,
    },
  ];
}

// Stash the grant anchor for the corner chat to consume on its next mount. Client-only; a no-window or a
// private window (sessionStorage throws) is a harmless no-op — the corner still opens, just as a general
// (unanchored) thread, so the worst case degrades to today's blank GrantBot rather than an error.
//
// A LAST-WRITE-WINS OVERWRITE, deliberately: it lives under its OWN key (askContextKey), separate from
// the composer-draft stash, so it can never clobber a half-typed message / pasted email / attachment.
// Clicking the button again (a different grant) just replaces the pending anchor with the latest one.
export function stashAskContext(clientId: string, ctx: AskContext): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(askContextKey(clientId), JSON.stringify(ctx));
  } catch {
    // Private mode / quota. Degrade to opening the corner without the anchor (a general thread).
  }
}

// Read-and-clear the pending grant anchor: it belongs to the mount that picks it up, and leaving it
// behind would re-anchor the next unrelated thread. Returns null when absent or malformed (a corrupt
// entry just means a general thread, never a crash).
export function takeAskContext(clientId: string): AskContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(askContextKey(clientId));
    if (!raw) return null;
    window.sessionStorage.removeItem(askContextKey(clientId));
    const parsed = JSON.parse(raw) as Partial<AskContext>;
    if (typeof parsed.grantId !== "string" || !parsed.grantId) return null;
    return { grantId: parsed.grantId, grantTitle: typeof parsed.grantTitle === "string" ? parsed.grantTitle : "" };
  } catch {
    return null;
  }
}

// The open target: the existing "open the corner on a blank thread" deep-link for this client. Both the
// launcher (today) and the Switcher (live) honour ?grantbot= on the dashboard route.
export function askOpenHref(clientId: string): string {
  return `/clients/${clientId}?grantbot=${BLANK_CONVERSATION}`;
}
