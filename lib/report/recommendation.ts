// ── The Send/Pass recommendation — the closing CALL of the match assessment ─────────────────────────
//
// WHAT THIS IS. The card carries all the analysis (score, QA-corrected narrative, role, freshness) but
// stops short of the verdict. This is the closing line that STATES it: SEND (and in what capacity —
// prime / sub / co-applicant) or PASS. It is SYNTHESIS, NOT A NEW JUDGMENT: the call is a pure,
// DETERMINISTIC projection of the score the platform already stands behind, never a fresh model opinion.
//
// WHY DETERMINISTIC (not model-generated):
//   - Faithful by construction — a projection of `resolveFit`'s coalesced score CANNOT say SEND on a
//     floored card or PASS on a strong one, and it invents no reason. It states the judgment; it does
//     not re-make it.
//   - Never-hide holds trivially — it is advice rendered on the card, changing no decision / suppress /
//     score. It informs the button the reviewer presses; it never presses it.
//   - It is a faithfulness BACKSTOP for the narrative, not a new drift surface: if the QA narrative prose
//     ever drifted toward "send" language on a demoted-to-1 card, this deterministic PASS line is the
//     authoritative counter-statement. Zero model tokens are spent here.
//   - It covers EVERY card, including the SEND/affirm majority the demote-only narrative never touches.
//
// CLIENT VISIBILITY (console = client report 1-for-1):
//   - A SEND is client-safe advice (the capacity is the card's own proposed role, already the navy role
//     pill on the portal) and renders on both surfaces.
//   - A PASS is STAFF-ONLY. A passed grant never reaches a client — but never-hide lets a low-fit card be
//     sent anyway, and the client must never read "Pass". So on the client side a PASS yields NO
//     recommendation at all (the same null-pattern toReportItem / qaVerdict already use for the two paths).
//
// The band mapping (Shannon, 2026-08-31): 1 → PASS, 2 → SEND (conditional — a real structure is
// required: MOU / co-applicant / cost-share), 3 → SEND (clean). A 2 must read as visibly conditional,
// distinct from a clean 3 — `conditional` drives that treatment in the component.

export type RecommendationCall = "SEND" | "PASS";

export interface Recommendation {
  // The decision, side-independent: SEND (worth putting in front of the client) or PASS (walk away).
  call: RecommendationCall;
  // The CLIENT-SAFE display verb, chosen by `side`. On the STAFF screen "Send"/"Pass" — Shannon's own
  // action words. On the CLIENT portal a SEND reads "Pursue" (their DecisionBar verb): "Send" is OUR
  // internal action (we send it to them), so it would be internal framing on a client page. A client
  // never sees a PASS, so no client verb is ever needed for one.
  verb: string;
  // The capacity to pursue in — verbatim from the card's proposed_role (already client-visible as the
  // role pill), so it introduces no new claim. Null when the card carries no proposed role.
  capacity: string | null;
  // SEND only: true for a fit-2 (viable ONLY via the right structure — a genuine condition), false for a
  // clean fit-3. Drives the visibly-distinct "conditional" treatment so a 2 never reads like a 3.
  conditional: boolean;
}

// Derive the recommendation from the DISPLAYED (QA-coalesced) fit score + the card's proposed role.
// `side` gates client visibility of a PASS AND picks the client-safe verb. Returns null when there is
// nothing to state (no score, or a PASS on the client side).
export function buildRecommendation(
  fitScore: 1 | 2 | 3 | null,
  proposedRole: string | null,
  side: "staff" | "client",
): Recommendation | null {
  if (fitScore == null) return null;
  const capacity = proposedRole?.trim() || null;

  if (fitScore === 1) {
    // PASS is the platform's call to walk away; it is staff-only (see the client-visibility note above).
    return side === "client" ? null : { call: "PASS", verb: "Pass", capacity, conditional: false };
  }

  // 2 → SEND but conditional on the partnering structure; 3 → clean SEND. Both are client-safe advice.
  const verb = side === "client" ? "Pursue" : "Send";
  return { call: "SEND", verb, capacity, conditional: fitScore === 2 };
}
