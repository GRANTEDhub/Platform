// "Ask GrantBot" from the grant review screen: the seam that lets a staffer, looking at one grant
// card, open the per-client GrantBot with a grant-specific question already in the composer — instead
// of navigating to the client, opening GrantBot, and retyping who the client is and which grant.
//
// WHY THIS IS A THIN, MECHANISM-FREE SEAM (and reuses only proven flows):
//   - GrantBot is per-CLIENT, not per-grant (there is no grantId anywhere in its wire/store), so
//     "scoped to this grant" means the grant is NAMED in the seeded question. The client's context
//     pack already loads its matched grants (gather.ts), so a grant named by title resolves against
//     context GrantBot already holds.
//   - Opening is the EXISTING deep-link: `/clients/<id>?grantbot=new`, which the corner GrantBot
//     already honours on the dashboard route — the launcher today (server-read into startOpen), and
//     the Switcher when that flag is on. Seeding is the EXISTING composer stash (draftKey), which
//     GrantBotChat reads-and-clears once on mount (takeDraft). So this adds NO new open/seed
//     machinery and NO change to any GrantBot component — it writes the stash and navigates. When the
//     universal Switcher is later turned on, the SAME navigate URL still works, so the button never
//     needs reworking; docking the panel in place on the review sub-route is a separate future polish.
//
// FLAG-GATED, byte-identical OFF: the review page renders the button only when
// GRANTBOT_ASK_FROM_REVIEW_ENABLED is on, so off is exactly today's page.

import { BLANK_CONVERSATION, draftKey } from "@/lib/grantbot/wire";

// Server-read flag (the review page gates the button on it). Off unless exactly "true" — the same
// shape as the other GrantBot flags; never NEXT_PUBLIC_, so it is read server-side and the button is
// simply not rendered when off (no client bundle change, no affordance).
export function grantbotAskFromReviewEnabled(): boolean {
  return process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED === "true";
}

export interface AskStarter {
  // Stable id for the React key and tests.
  key: string;
  // The short pill label the staffer clicks.
  chip: string;
  // The full question seeded into the composer — names BOTH the client and the grant so GrantBot has
  // the scope without the staffer retyping it, and frames the grant-advisory distinctions GRANTED
  // cares about (who actually wins, prime vs partner/sub, deadline reality incl. registration + LOE).
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

// Seed a starter question into the client's composer stash, in the EXACT shape GrantBotChat's
// takeDraft expects (draft set, every other field empty/null). Client-only; a no-window or a private
// window (sessionStorage throws) is a harmless no-op — the corner still opens, just without the
// pre-fill, so the worst case degrades to today's blank composer rather than an error.
export function stashAskDraft(clientId: string, question: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      draftKey(clientId),
      JSON.stringify({ draft: question, pasted: "", pasteLabel: "", attachedFile: null, attachedImage: null }),
    );
  } catch {
    // Private mode / quota. Degrade to opening the corner without the seed.
  }
}

// The open target: the existing "open the corner on a blank thread" deep-link for this client. Both
// the launcher (today) and the Switcher (when enabled) honour ?grantbot= on the dashboard route.
export function askOpenHref(clientId: string): string {
  return `/clients/${clientId}?grantbot=${BLANK_CONVERSATION}`;
}
