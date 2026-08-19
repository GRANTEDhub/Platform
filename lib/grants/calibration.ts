import type { createServiceClient } from "@/lib/supabase/server";
import type { MatchResult } from "@/lib/grants/engine";

// ── Feedback → scoring calibration consumer (MATCH_CALIBRATION_ENABLED) ──────────────────
// Reads a client's past match_feedback and applies a BOUNDED, DOWNWARD-ONLY nudge to the
// engine's fit_score for NEAR-IDENTICAL grants (same seat family + overlapping focus area).
// It is the automated replacement for the manual "staffer hand-writes matching_rules" bridge.
//
// It never rewrites the engine. It runs post-model in scoreGrantClientPair (the one seam
// between score-computed and card-written) and produces a new MatchResult; engine.ts is
// untouched. See CLAUDE.md for the locked design.
//
// SAFETY INVARIANTS — all locked in calibration.test.ts:
//  1. Identity on empty. No relevant feedback → the engine score is returned UNCHANGED. This is
//     the cold-start guarantee, and it holds independent of the flag (a launched client with no
//     feedback yet scores exactly as today).
//  2. Per-client only. loadClientFeedback filters on client_id. The scoring path runs
//     service-role, so RLS is BYPASSED — this predicate, not RLS, is the isolation boundary.
//  3. Bounded. At most a ONE-POINT move, downward only, and only once ~K consistent passes
//     accrue: a single pass (and, with K=5, up to four) moves the integer score by nothing.
//
// LAUNCH CONSERVATISM (deliberate, widen later): relevance is the TIGHTEST scope (seat family
// AND focus overlap); the nudge is downward-only (a pass is never an argument to RAISE a score,
// and downward-only can never break the engine's seat ceiling); agreements do not offset. Each
// re-score applies the nudge to the FRESH engine score, so it never compounds across cycles.

const K = 5; // shrinkage: half-influence at K relevant passes; a single pass is negligible
const MAX_DELTA = 1; // hard cap — calibration never moves the score more than one point
// Each relevant pass is a UNIT negative signal. A pass is the thing the product actually
// collects (the Disagree/Pass control posts no corrected_score — by design, see
// score-feedback.tsx), so a pass must count as a full -1: with per-pass magnitude of 1,
// `|s·w| = n/(n+K)` crosses 0.5 at n=K, giving the spec exactly — a single pass (up to K-1)
// moves nothing, ~K consistent passes move one point. A graded correction, if one is ever
// submitted, is clamped to the SAME [-1,0] band so it can't outrun a pass or fire on a single
// harsh row. (BARE_PASS was -0.5, which never crossed the round() threshold — bare passes,
// i.e. all real feedback, could never move a score. That was the whole feature being inert.)
const BARE_PASS = -1; // a pass with no corrected_score is a full unit negative signal

// The derivation note calibration appends, and the marker BOTH the writer (below) and the
// readers (the report surfaces, via wasCalibrated) key off — ONE string, so a rendered "why"
// can never disagree with what calibration actually wrote.
export const CALIBRATION_NOTE_MARKER = "Calibration: lowered";

// Did calibration move this card's score? Reads the engine's own derivation note. The report
// surfaces use it to explain a calibration-driven drop instead of misattributing it to a factor.
export function wasCalibrated(derivation: string | null | undefined): boolean {
  return (derivation ?? "").includes(CALIBRATION_NOTE_MARKER);
}

export interface CalibrationRow {
  agree: boolean;
  corrected_score: number | null;
  engine_score: number | null;
  engine_seat_ref: string | null;
  focusAreas: string[];
  // The referenced review card's decision. A GENUINE PASS (`passed`) is the only downward
  // signal we trust: the Disagree/score-QA control is direction-neutral ("what did it get
  // wrong?"), so a bare `agree=false` row can mean "too high" OR "too low", but a card that
  // was actually PASSED is unambiguously "we didn't want this". null for attempt-referenced
  // rows (suppressed-match / false-negative flags), which are never a downward signal.
  decision: string | null;
}

// Cross-grant-comparable seat archetype. A raw seat_ref (P0 / S1_2 / NONE) is grant-specific, but
// its FAMILY — prime / supporting / none — is comparable across grants, which is what "same seat
// archetype" means for relevance.
export function seatFamily(seatRef: string | null | undefined): "prime" | "supporting" | "none" {
  const s = (seatRef ?? "").trim().toUpperCase();
  if (s.startsWith("P")) return "prime";
  if (s.startsWith("S")) return "supporting";
  return "none";
}

function overlaps(a: string[], b: string[]): boolean {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a.map((x) => x.trim().toLowerCase()).filter(Boolean));
  return b.some((x) => set.has(x.trim().toLowerCase()));
}

// PURE — the whole adjustment, testable without a DB or the flag.
export function applyCalibration(
  match: MatchResult,
  feedback: CalibrationRow[],
  grantFocusAreas: string[],
): MatchResult {
  // Never calibrate a hard-gated match: suppression / disqualification is structural, not a
  // scoring judgement that feedback may touch.
  if (match.suppressed || match.disqualified) return match;

  const family = seatFamily(match.seat_ref);
  // TIGHTEST relevance (launch default): a client's past PASS counts only when it shares this
  // grant's seat family AND an overlapping focus area — so a bad match on one category can never
  // tug an unrelated one. A signal is a GENUINE PASS: the card was actually `passed`
  // (`decision === "passed"`), not merely score-QA-disagreed-with — the Disagree control is
  // direction-neutral, so a bare `agree=false` alone can't tell "too high" from "too low", but a
  // passed card is unambiguously downward. Agreements are excluded (`agree === false`); only
  // passes are a calibration signal.
  const relevant = feedback.filter(
    (r) =>
      r.agree === false &&
      r.decision === "passed" &&
      seatFamily(r.engine_seat_ref) === family &&
      overlaps(r.focusAreas, grantFocusAreas),
  );
  const n = relevant.length;
  if (n === 0) return match; // cold-start / no relevant feedback → identity

  // Each pass is a negative signal clamped to the [-1, 0] band: an explicit corrected_score
  // gives the signed correction (clamped to <= 0 — a pass is never an argument to raise — and
  // floored at -1 so one harsh row can't move the score on its own), a bare pass a full -1.
  const contributions = relevant.map((r) =>
    r.corrected_score != null && r.engine_score != null
      ? Math.max(-1, Math.min(0, r.corrected_score - r.engine_score))
      : BARE_PASS,
  );
  const s = contributions.reduce((a, b) => a + b, 0) / n; // mean signal, <= 0
  const w = n / (n + K); // confidence: 0 at n=0, grows with the corpus
  const capped = Math.max(s * w, -MAX_DELTA); // <= 0, floored at -1
  // Magnitude-symmetric rounding so |delta| >= 0.5 moves exactly one point; downward only.
  const deltaInt = -Math.round(Math.abs(capped));
  if (deltaInt === 0) return match; // below the threshold to move an integer score → identity

  const engineScore = match.fit_score;
  const calibrated = Math.max(0, engineScore + deltaInt) as 0 | 1 | 2 | 3;
  if (calibrated === engineScore) return match;

  // Explainable: record THAT calibration moved the score and WHY, in the reasoning the card
  // renders — never a silent adjustment.
  const note = `${CALIBRATION_NOTE_MARKER} ${engineScore}→${calibrated} from ${n} prior pass${
    n === 1 ? "" : "es"
  } on same-seat, same-focus grants (confidence ${w.toFixed(2)}).`;
  const rc = match.reasoning_context;
  return {
    ...match,
    fit_score: calibrated,
    reasoning_context: rc
      ? { ...rc, fit_score_derivation: `${rc.fit_score_derivation ?? ""}\n${note}`.trim() }
      : rc,
  };
}

// The DB read — the ONLY per-client-scoped query, and the isolation boundary (client_id
// predicate, since the scoring path is service-role / RLS-bypassed). Locked in the test.
export async function loadClientFeedback(
  db: ReturnType<typeof createServiceClient>,
  clientId: string,
): Promise<CalibrationRow[]> {
  const { data, error } = await db
    .from("match_feedback")
    .select("agree, corrected_score, engine_score, engine_seat_ref, grants(focus_areas), review_cards(decision)")
    .eq("client_id", clientId);
  if (error || !data) return [];
  type Row = {
    agree: boolean;
    corrected_score: number | null;
    engine_score: number | null;
    engine_seat_ref: string | null;
    grants: { focus_areas: string[] | null } | { focus_areas: string[] | null }[] | null;
    review_cards: { decision: string | null } | { decision: string | null }[] | null;
  };
  return (data as Row[]).map((r) => {
    const g = Array.isArray(r.grants) ? r.grants[0] : r.grants;
    const c = Array.isArray(r.review_cards) ? r.review_cards[0] : r.review_cards;
    return {
      agree: r.agree,
      corrected_score: r.corrected_score,
      engine_score: r.engine_score,
      engine_seat_ref: r.engine_seat_ref,
      focusAreas: g?.focus_areas ?? [],
      decision: c?.decision ?? null,
    };
  });
}

// The orchestrator the scorer's hot path calls (scoreGrantClientPair). Flag-gated: OFF → the
// engine score is returned untouched with NO DB read, byte-identical to pre-calibration; ON →
// per-client feedback loaded and a bounded nudge applied (still identity when there's none).
export async function calibrateMatch(
  db: ReturnType<typeof createServiceClient>,
  match: MatchResult,
  clientId: string,
  grantFocusAreas: string[],
): Promise<MatchResult> {
  if (process.env.MATCH_CALIBRATION_ENABLED !== "true") return match;
  const feedback = await loadClientFeedback(db, clientId);
  return applyCalibration(match, feedback, grantFocusAreas);
}
