// Grant disposition — the Ledger's read-time summary of "what happened" to a
// grant across the full funnel. DERIVED, never stored: a pure function of the
// grant's operational status + gate fields + its cards' decisions. Keeping it
// derived (like the client-first gate) is the deliberate state-model choice --
// a decision is a transition, not a terminal flag, so a grant can sit in the
// Ledger AND later in a per-card relationship/outcome layer with no rework.
//
// The future outcome layer (pursued / applied / won / lost) bolts onto the CARD
// (per client-grant or prospect-grant relationship), not the grant -- so nothing
// here needs to change when it lands.

import type { Grant, CardDecision } from "@/types/database";

export type DispositionTier =
  | "processing"
  | "error"
  | "forecasted"
  | "not_pursued"
  | "no_match"
  | "profile_gap"
  | "matched_pending"
  | "matched_rejected"
  | "matched_alerted";

export interface GrantDisposition {
  tier: DispositionTier;
  label: string;
  detail: string | null;
}

export interface DispositionCard {
  card_type: string | null;
  decision: CardDecision;
  org_name: string | null;
}

type DispGrant = Pick<
  Grant,
  | "status"
  | "is_domestic"
  | "hard_disqualifiers"
  | "skip_reason"
  | "error_detail"
  | "grant_status"
  | "shred_depth"
  | "shred_reason"
  | "description"
  | "ideal_profile_error"
> & {
  // Whether an ideal_applicant_profile exists. Passed explicitly (not Picked from
  // Grant) so a caller can supply it from a lightweight `is not null` query without
  // fetching the large jsonb column.
  has_ideal_profile: boolean;
};

const DECIDED = new Set<CardDecision>(["approved", "passed"]);

// The resolver logs this verbatim (lib/grants/nofo.ts) when a structured
// additional_info_url link-out WAS followed but no NOFO validated -- the STRONG
// signal that a real NOFO exists behind a portal/JS wall and is worth a manual
// hunt, vs. a grant with nothing to chase.
const RESOLVER_LINK_UNRESOLVED = "additional_info_url did not yield a NOFO";
// Secondary, LOWER-confidence signal: the description itself carries a URL or a
// known application-portal marker. Deliberately narrow so the triage queue stays
// high-signal -- we would rather under-flag and loosen once real volume shows.
const DESCRIPTION_PORTAL =
  /(https?:\/\/|nasaprs|nspires|sam\.gov\/opp|grants\.nih\.gov|see the (full )?(announcement|solicitation)|full announcement (is )?(available )?at)/i;

// A willScore=true, complete grant with NO profile: an instrumentation gap, not a
// genuine "no match". Split by sub-cause so the label states the ACTION (text, not
// color): Stage-A failure -> retry; unreachable/description NOFO -> manual hunt.
function profileGapDisposition(grant: DispGrant): GrantDisposition {
  // FULL shred + no profile => Stage A ran and threw (the now-recorded swallow).
  if (grant.shred_depth === "full") {
    return {
      tier: "profile_gap",
      label: "Profile gap · Stage-A failed (retry)",
      detail: grant.ideal_profile_error ?? "Profiling failed; no error recorded (retry to capture it).",
    };
  }
  // SUMMARY shred => no full NOFO was reached, so Stage A never ran. Sub-classify
  // how reachable a real NOFO looks so the manual-hunt queue isn't noise.
  const reason = grant.shred_reason ?? "";
  if (reason.includes(RESOLVER_LINK_UNRESOLVED)) {
    return {
      tier: "profile_gap",
      label: "Profile gap · NOFO unreachable (manual hunt)",
      detail: `Link-out didn't resolve — likely a real NOFO behind a portal. ${reason}`,
    };
  }
  if (grant.description && DESCRIPTION_PORTAL.test(grant.description)) {
    return {
      tier: "profile_gap",
      label: "Profile gap · NOFO may be in description (low confidence)",
      detail: `Possible portal/link in the description — lower-confidence lead. ${reason || "summary shred"}`,
    };
  }
  return {
    tier: "profile_gap",
    label: "Profile gap · no NOFO found",
    detail: reason || "Summary shred; no reachable NOFO.",
  };
}

export function getGrantDisposition(grant: DispGrant, cards: DispositionCard[]): GrantDisposition {
  // Forecasted opportunities have no NOFO published yet, so a summary shred or a
  // failed/stuck pipeline is expected noise, not a real failure. Checked FIRST so
  // it takes precedence over the operational error/processing labels below.
  if (grant.grant_status === "Forecasted")
    return { tier: "forecasted", label: "Forecasted", detail: "No NOFO published yet" };

  // Operational, still in flight. The matching queue (Move 2) parks a grant at
  // 'queued' (waiting for the drain) and 'matching' (drain is scoring it); both
  // are in-flight, NOT terminal -- map them to the processing tier so a
  // freshly-queued grant is never shown as "No match" (it has no cards yet only
  // because matching hasn't run). Distinct labels; same tier.
  if (grant.status === "processing") return { tier: "processing", label: "Processing", detail: null };
  if (grant.status === "queued") return { tier: "processing", label: "Queued", detail: null };
  if (grant.status === "matching") return { tier: "processing", label: "Matching", detail: null };
  if (grant.status === "error")
    return { tier: "error", label: "Analysis failed", detail: grant.error_detail ?? null };

  // Not pursued (gate failures). International and hard disqualifiers derive
  // from existing fields; skip_reason carries the grant-level suppression.
  // International is never overridable (domestic-only mandate), so it wins
  // unconditionally -- a card can never exist for one.
  if (!grant.is_domestic)
    return { tier: "not_pursued", label: "Not pursued", detail: "International — excluded by policy" };

  // Grant-level suppression gates (hard_disqualifiers / skip_reason) mean the
  // engine never pursued this -- BUT a human can force a card past them (manual
  // add-to-client override). When a card exists, its outcome is the real
  // disposition, so these gates only apply when NO card exists; otherwise a forced
  // match would be wrongly hidden behind "Not pursued". Only qualifying matches
  // (fit >= 2) or a human override become cards.
  if (cards.length === 0) {
    if ((grant.hard_disqualifiers?.length ?? 0) > 0)
      return { tier: "not_pursued", label: "Not pursued", detail: grant.hard_disqualifiers!.join("; ") };
    if (grant.skip_reason)
      return { tier: "not_pursued", label: "Not pursued", detail: grant.skip_reason };
    // Reaching here = willScore=true (domestic, no hard-disq, no skip, not
    // forecasted) + complete + no cards. A MISSING profile is an instrumentation
    // gap (a swallowed Stage-A failure or an unreachable NOFO), NOT a genuine "no
    // match" -- surface it distinctly so it can never hide inside No match again.
    if (!grant.has_ideal_profile) return profileGapDisposition(grant);
    return { tier: "no_match", label: "No match", detail: null };
  }

  // Cards exist. A human DECISION (approved/passed) is the real disposition and
  // wins (rendered below) -- a resolved grant is never resurfaced as "needs
  // attention". But an all-PENDING card set on a willScore-eligible grant with NO
  // profile is a stale match generated without a real profile: the actionable truth
  // is the missing profile, so route it to profile_gap exactly like the no-card
  // case. (A single approved/passed card exempts the whole grant.)
  const willScoreEligible =
    (grant.hard_disqualifiers?.length ?? 0) === 0 && !grant.skip_reason;
  const hasDecidedCard = cards.some((c) => DECIDED.has(c.decision));
  if (!hasDecidedCard && willScoreEligible && !grant.has_ideal_profile)
    return profileGapDisposition(grant);

  const orgs = (cs: DispositionCard[]) =>
    cs.map((c) => c.org_name).filter(Boolean).join(", ") || null;

  // Alert is the headline outcome: any approved card -> the grant transitioned
  // into a relationship (recorded here AND, later, in the relationship layer).
  const approved = cards.filter((c) => c.decision === "approved");
  if (approved.length > 0) return { tier: "matched_alerted", label: "Alerted", detail: orgs(approved) };

  // Any undecided card (pending / hold) -> still in review.
  if (cards.some((c) => !DECIDED.has(c.decision)))
    return { tier: "matched_pending", label: "In review", detail: orgs(cards) };

  // All decided, none approved -> all rejected.
  return { tier: "matched_rejected", label: "Rejected", detail: orgs(cards) };
}
