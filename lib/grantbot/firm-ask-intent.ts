// "Ask GrantBot" on the prospecting page (/intel/[id]) — the FIRM-bot sibling of ask-intent.ts. A
// staffer looking at a grant's surfaced prospects opens the FIRM GrantBot at a NEW thread anchored to
// that grant, so they can ask "why did you surface X over the others?" without re-typing the setup.
//
// WHY THE FIRM BOT (Shannon, decided): the firm bot is already the general "no single client, sees the
// whole roster" strategist. Prospecting is about NEW orgs, not one existing client — so we hand the firm
// bot the grant + its surfaced prospects as additional context (the same pattern the per-client bot gets
// its grant), rather than inventing a new conversation type. The grant + prospects grounding is composed
// SERVER-SIDE from the grant's own row (firm-focus.ts); the client only supplies a POINTER (the id).
//
// The anchor rides sessionStorage under a FIRM key (no client id — the firm bot has no client), read-and-
// cleared by the firm chat on mount, mirroring the per-client askContextKey. FLAG-GATED, byte-identical
// OFF: the page renders the button and the firm-turn route honours the anchor only when
// GRANTBOT_ASK_FROM_PROSPECTING_ENABLED is on (and the firm bot itself needs GRANTBOT_FIRM_ENABLED).

import { firmAskContextKey, type AskContext } from "@/lib/grantbot/wire";
import type { AskStarter } from "@/lib/grantbot/ask-intent";

// Server-read flag (the page gates the button on it; the firm-turn route honours the anchor on it). Off
// unless exactly "true" — the standard GrantBot-flag shape; never NEXT_PUBLIC_, so it is read server-side
// and the button is simply not rendered when off (no client bundle change, no affordance). INDEPENDENT of
// the per-client GRANTBOT_ASK_FROM_REVIEW_ENABLED so the two ask surfaces are decoupled.
export function grantbotAskFromProspectingEnabled(): boolean {
  return process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED === "true";
}

// The three prospecting-focused starter questions, rendered as clickable chips in the new thread's empty
// state (they fill the composer; a free-form question is still grant-scoped). Pure + exported so their
// shape/text is unit-tested. Distinct from the per-client askStarters (who-wins / eligibility / deadline)
// — these lead with the surfaced-prospects question that is the whole reason this surface exists.
export function firmAskStarters(grantTitle: string): AskStarter[] {
  const grant = grantTitle.trim() || "this grant";
  return [
    {
      key: "why_these",
      chip: "Why these prospects?",
      question: `Of the prospects surfaced for ${grant}, why these organizations over the others — what made each a fit, and which is the strongest?`,
    },
    {
      key: "who_wins",
      chip: "Who actually wins this?",
      question: `Who actually wins ${grant}? What applicant type or profile tends to get funded, and how do the surfaced prospects stack up against that field?`,
    },
    {
      key: "eligibility",
      chip: "Prime vs. sub?",
      question: `For ${grant}, which of the surfaced prospects could realistically be a PRIME applicant versus only a partner/sub — and what entity-type or registration gates decide it?`,
    },
  ];
}

// Stash the grant anchor for the firm chat to consume on its next mount. Client-only; a no-window or a
// private window (sessionStorage throws) is a harmless no-op — the corner still opens, just as a general
// (unanchored) firm thread. LAST-WRITE-WINS under its OWN key, separate from any composer draft.
export function stashFirmAskContext(ctx: AskContext): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(firmAskContextKey, JSON.stringify(ctx));
  } catch {
    // Private mode / quota. Degrade to opening the firm bot without the anchor (a general thread).
  }
}

// Read-and-clear the pending firm grant anchor: it belongs to the mount that picks it up. Returns null
// when absent or malformed (a corrupt entry just means a general thread, never a crash).
export function takeFirmAskContext(): AskContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(firmAskContextKey);
    if (!raw) return null;
    window.sessionStorage.removeItem(firmAskContextKey);
    const parsed = JSON.parse(raw) as Partial<AskContext>;
    if (typeof parsed.grantId !== "string" || !parsed.grantId) return null;
    return { grantId: parsed.grantId, grantTitle: typeof parsed.grantTitle === "string" ? parsed.grantTitle : "" };
  } catch {
    return null;
  }
}
