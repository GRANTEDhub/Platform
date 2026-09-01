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
// The band mapping (Shannon, 2026-08-31): 1 → PASS, 2 → SEND (conditional — worth pursuing but it
// hinges on something the analysis names), 3 → SEND (clean). A 2 must read as visibly conditional,
// distinct from a clean 3 — `conditional` drives that treatment in the component. The condition is
// REASON-AGNOSTIC on the line: a fit-2 can be a partner-structure fit, a generic-nexus adjacency
// demote (unconfirmed program history), or a calibration demote, so the line marks it conditional but
// NEVER names the fix — the specific condition lives in the prose above it.

// ── The verdict LEAD — the go/no-go call that OPENS the IntellEngine Intel paragraph ────────────────
//
// The Send/Pass line above is the closing LABEL; this is the OPENING CALL of the verdict paragraph. Same
// principle, same source: DETERMINISTIC, pinned to the displayed score (Shannon's decision, 2026-09-01 —
// "the score sets the directional call; the prose writes the reasoning under a call it can't override").
// The model writes the reasoning that FOLLOWS this lead; it never authors the call, so prose and score
// cannot disagree by construction — no guard, no fallback.
//
// HARD-KILL LEAD. Two certain disqualifiers lead DETERMINISTICALLY as facts, not model judgments:
//   - `closed`     — the submission deadline has passed (reliable today: it's a date we hold). Orthogonal
//                    to fit, so it does NOT pin the score — it forces the CALL to no-go ("strong fit, but
//                    the deadline passed" is coherent), and the page still shows the engine's fit bars.
//   - `ineligible` — computeEligibility returned a structural limit (an eligibility CLAIM). The page pins
//                    the DISPLAYED score to 1 for this, so the score bars, this lead, and the Send/Pass
//                    line all read no-go together — killing the "3 above 'ineligible'" contradiction.
// (Archived-at-source is deliberately NOT here — that signal is what the freshness bug corrupts; it lands
// when the freshness gate does. Shannon, 2026-09-01.)
export type VerdictCall = "no-go" | "marginal" | "go";

// A deterministic threshold kill the page detected. `detail` (ineligible only) is the eligibility gate's
// own short reason — never fabricated.
export interface HardKill {
  kind: "closed" | "ineligible";
  detail?: string | null;
}

export interface VerdictLead {
  call: VerdictCall;
  // The ready-to-render lead phrase, side-appropriate. The model's reasoning (or the engine paragraph)
  // renders immediately after it as ONE paragraph — e.g. "No-go for NWACC. This is a fossil-energy R&D
  // grant…". Client-safe by construction (a go/marginal is advice; a no-go never reaches the client side).
  text: string;
}

// Derive the verdict lead from the DISPLAYED score + any hard kill. `side` gates client visibility of a
// no-go (staff-only, like a PASS) and picks the phrasing (a client reads their own card, so a go is advice
// — "Worth pursuing" — not "Go for {them}"). Returns null when there is nothing to state (no score, or a
// no-go on the client side).
export function buildVerdict(
  fitScore: 1 | 2 | 3 | null,
  hardKill: HardKill | null,
  clientName: string,
  side: "staff" | "client",
): VerdictLead | null {
  const name = clientName.trim() || "this client";

  if (hardKill) {
    // A hard kill is a no-go, deterministically, with the disqualifier stated. No-go is staff-only.
    if (side === "client") return null;
    const reason =
      hardKill.kind === "closed"
        ? "the deadline has passed"
        : `ineligible${hardKill.detail?.trim() ? ` — ${hardKill.detail.trim()}` : " for this program"}`;
    return { call: "no-go", text: `No-go for ${name}: ${reason}.` };
  }

  if (fitScore == null) return null;

  if (fitScore === 1) {
    // No-go — staff-only (a "not a fit" verdict is never client advice; the client sees no lead).
    return side === "client" ? null : { call: "no-go", text: `No-go for ${name}.` };
  }
  if (fitScore === 2) {
    return side === "client"
      ? { call: "marginal", text: "Marginal — worth a look." }
      : { call: "marginal", text: `Marginal for ${name}.` };
  }
  // fitScore === 3 → go.
  return side === "client" ? { call: "go", text: "Worth pursuing." } : { call: "go", text: `Go for ${name}.` };
}

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
  // SEND only: true for a fit-2 (worth pursuing but conditional on something the analysis names — a
  // partner structure, unconfirmed history, or a calibration caveat), false for a clean fit-3. Drives
  // the visibly-distinct "conditional" treatment so a 2 never reads like a 3; the line never names the
  // condition (that would fabricate a fix), so this flag is reason-agnostic.
  conditional: boolean;
}

// Derive the recommendation from the DISPLAYED (QA-coalesced) fit score + the card's proposed role.
// `side` gates client visibility of a PASS AND picks the client-safe verb. A `hardKill` forces PASS
// regardless of score — the `closed` case is NOT score-pinned (a strong-fit-but-closed card keeps its
// fit bars), so without this a fit-3 whose deadline passed would still read "Send", contradicting the
// no-go verdict lead. (An `ineligible` kill is already score-pinned to 1 by the page, so it lands on
// PASS anyway; passing the kill here keeps the two paths uniform and self-documenting.) Returns null
// when there is nothing to state (no score, or a PASS/hard-kill on the client side).
export function buildRecommendation(
  fitScore: 1 | 2 | 3 | null,
  proposedRole: string | null,
  side: "staff" | "client",
  hardKill?: HardKill | null,
): Recommendation | null {
  const capacity = proposedRole?.trim() || null;

  if (hardKill) {
    // A hard kill is a walk-away, deterministically — PASS, staff-only (never the client "Pursue" verb).
    return side === "client" ? null : { call: "PASS", verb: "Pass", capacity, conditional: false };
  }

  if (fitScore == null) return null;

  if (fitScore === 1) {
    // PASS is the platform's call to walk away; it is staff-only (see the client-visibility note above).
    return side === "client" ? null : { call: "PASS", verb: "Pass", capacity, conditional: false };
  }

  // 2 → SEND but conditional (the analysis names on what); 3 → clean SEND. Both are client-safe advice.
  const verb = side === "client" ? "Pursue" : "Send";
  return { call: "SEND", verb, capacity, conditional: fitScore === 2 };
}
