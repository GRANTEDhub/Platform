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
  "status" | "is_domestic" | "hard_disqualifiers" | "skip_reason" | "error_detail" | "grant_status"
>;

const DECIDED = new Set<CardDecision>(["approved", "passed"]);

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
    return { tier: "no_match", label: "No match", detail: null };
  }

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
