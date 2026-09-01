import type { FactorScores } from "@/types/database";
import { stripSeatCodes } from "@/lib/grants/fit-narrative";

// ── The read-layer coalesce for the IntellEngine QA override (migration 0088) ───────────────────────
//
// The QA pass writes its applied verdict to SEPARATE qa_* override columns on review_cards; it never
// overwrites the engine's own fit_score / factor_scores. This module is the ONE place the app resolves
// the engine score/factors against that override layer for display — a single helper so no surface
// (list, detail, staff worklist) can drift on the staleness rule or the never-hide guarantee.
//
// Shared + pure + no DB, exactly like fit-factors.ts, so it is unit-tested in isolation.

// The columns the coalesce reads off a review_cards row: the engine's own score/factors plus the qa_*
// override layer. A subset — any fuller row (a full ReviewCard, a page's local CardRow) is assignable.
// The qa_* fields are OPTIONAL so a query that does not select them resolves to "no override" (the
// engine score/factors, no badge) rather than failing to typecheck — byte-identical to pre-0088 display.
export interface QaOverrideRow {
  fit_score: 1 | 2 | 3 | null;
  factor_scores: FactorScores | null;
  qa_fit_score?: number | null;
  qa_factor_scores?: FactorScores | null;
  qa_sources?: string[] | null;
  qa_narrative?: string | null;
  qa_status?: string | null;
  qa_engine_fit_score?: number | null;
}

// The client-safe QA badge a card renders when a verdict is in effect. `applied` carries the score
// change + the grounded .gov source URLs; `unverified` / `failed` are score-UNCHANGED "QA couldn't
// complete" states (the engine number stands). This is ONLY the client-safe projection — never the raw
// staff analyst note, which stays staff-only in card_intel_reviews and is never selected into this path.
export type QaVerdictView =
  | { status: "applied"; from: 1 | 2 | 3; to: 1 | 2 | 3; sources: string[] }
  | { status: "unverified" }
  | { status: "failed" };

export interface ResolvedFit {
  // The score to DISPLAY (and rank by): qa_fit_score when a fresh applied override is in effect, else
  // the engine's fit_score. Only ever lowers/keeps the number — never removes the card.
  fitScore: 1 | 2 | 3 | null;
  // The factors to DISPLAY: qa_factor_scores (the engine's real factors with QA's changed factor merged
  // in at write time) when applied+fresh, else the engine's factor_scores.
  factorScores: FactorScores | null;
  // The QA badge, or null when QA has reached no display state (or an applied override has gone stale).
  qa: QaVerdictView | null;
  // The client-safe verdict narrative (the go/no-go reasoning body) to DISPLAY IN PLACE OF the assembled
  // engine paragraph. Rides EVERY resolved verdict now — an affirm or flag carries its reasoning too, not
  // just a demote — so it is decoupled from a SCORE override: it shows whenever qa_narrative is present AND
  // fresh (its engine-score snapshot still matches), regardless of whether qa_fit_score is set. Null when
  // absent or stale → the card renders today's lead/blocking/mitigation. Client-safe by construction
  // (guarded at generation time), so it rides to both console and portal.
  narrative: string | null;
}

const asFit = (n: number | null | undefined): 1 | 2 | 3 | null => (n === 1 || n === 2 || n === 3 ? n : null);

// Resolve the engine score/factors against the qa_* override layer.
//
// STALENESS: an applied override is honored ONLY while qa_engine_fit_score (the engine score QA judged)
// still equals the current fit_score. A rematch that changes the engine score makes the snapshot stale →
// the override is ignored, the engine score shows, and the poller re-QAs. So an old QA number can never
// sit on top of a freshly re-scored card, with zero coupling to the protected write path.
//
// NEVER-HIDE: this only swaps the displayed number/factors and adds a badge. There is no path that
// removes a card (review_cards has no suppress column); a demote drives the score to the floor and the
// row still surfaces.
//
// OFF is inert: with every qa_* column null (AUTO_INTEL_APPLY off, or no QA yet) it returns the engine
// score/factors and no badge — byte-identical to pre-0088 display.
export function resolveFit(row: QaOverrideRow): ResolvedFit {
  const engineFit = asFit(row.fit_score);
  const engineFactors = row.factor_scores ?? null;
  const status = row.qa_status ?? null;

  const qaFit = asFit(row.qa_fit_score);
  const snapshot = asFit(row.qa_engine_fit_score);
  // The freshness snapshot is shared: it gates a SCORE override AND, independently, the verdict narrative.
  // Both are honored only while the engine score QA judged still matches the current one.
  const snapshotFresh = snapshot !== null && snapshot === engineFit;
  const appliedFresh = status === "applied" && qaFit !== null && snapshotFresh;

  // The narrative is DECOUPLED from the score override: an affirm/flag carries a reasoning body with no
  // score change (qa_fit_score null, status 'none'), and it must still render. So it keys on qa_narrative
  // present + the snapshot fresh, NOT on appliedFresh — a fresh demote, affirm, or flag narrative all show;
  // an absent one, or a stale one (engine re-scored), falls back to the engine paragraph.
  // Scrub the matcher's internal seat/role codes (S0_2, P0) at the read boundary too — narrativeGuard
  // strips them at generation, but this also cleans narratives stored before that landed, on every surface.
  const narrative =
    snapshotFresh && typeof row.qa_narrative === "string" && row.qa_narrative.trim()
      ? stripSeatCodes(row.qa_narrative) || null
      : null;

  if (appliedFresh) {
    const sources = (row.qa_sources ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
    return {
      fitScore: qaFit,
      factorScores: row.qa_factor_scores ?? engineFactors,
      // engineFit is provably 1|2|3 here: appliedFresh required snapshot === engineFit and snapshot !== null.
      qa: { status: "applied", from: engineFit as 1 | 2 | 3, to: qaFit, sources },
      narrative,
    };
  }

  // No fresh applied SCORE override → the engine score stands. Surface a soft "couldn't complete" badge when
  // QA reached that state (unverified nulls its own score columns at write time, so nothing is stale to
  // guard). A STALE applied row also falls through here → engine score, no badge (a fresh QA pass pending).
  // The narrative still rides through when it is fresh (an affirm/flag, or a not-yet-stale demote reasoning).
  const qa: QaVerdictView | null =
    status === "unverified" ? { status: "unverified" } : status === "failed" ? { status: "failed" } : null;
  return { fitScore: engineFit, factorScores: engineFactors, qa, narrative };
}
