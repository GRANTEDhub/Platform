// Mission gate — a strict, flag-gated, DOWNWARD-ONLY suppression of CONFIDENT-no-fit matches.
//
// The problem it targets: a narrow class of over-surfacing / over-routing — an entity-eligible org
// (often a county or other government) that the occupancy model CONFIDENTLY judged does not perform
// this grant's core program. The model already emits the signal; this gate just ACTS on it.
//
// STRICT THREE-SIGNAL BAR — all must hold, deliberately conservative (err toward SURFACING):
//   1. result.disqualified === true        — the model made a hard call, not a soft fit concern.
//   2. seat_ref is NONE / empty            — the model placed the client in no seat at all.
//   3. disqualify_reason is MISSION-based  — a Gate-4 purpose/program-fit reason (the client does
//                                            not do this work), NOT entity-type / geography /
//                                            deadline / award-size.
// A thin-profile GENUINE fit fails signal 1 or 2 (it is not disqualified, or it holds a seat) and is
// therefore UNTOUCHED. A missed match is the expensive invisible error; a mediocre-but-surfaced one
// is caught at console review. Widen this bar later once watched — never the reverse.
//
// ORDERING IS LOAD-BEARING. This runs INSIDE matchGrantToClient, BEFORE routeSupportingSeat. It sets
// suppressed=true, and subseat-routing's isRoutingCandidate bails on result.suppressed (and never
// writes suppressed in either direction) — so a confident mission-disqualify can NEVER be resurrected
// into a Sub seat, and the two live fixes cannot fight (no un-suppress path exists). Placing this in
// pipeline.ts (after matchGrantToClient returns) would be too late: sub-routing would already have run.
//
// WHY SIGNAL 3 (mission-based) IS THE ONE THAT MATTERS FOR THE INTERACTION: an ENTITY-TYPE disqualify
// (prime-ineligible but may still do the work) is EXACTLY sub-routing's population — it must stay
// routable. A MISSION disqualify (does not do the work) must not. The classifier below anchors on
// PURPOSE / what-the-client-does language and deliberately EXCLUDES seat-absence phrasing ("no seat"),
// so it can never fire on an entity-ineligible-but-seat-fillable specialist and block the sub-router.
//
// Flag OFF (or unset) is IDENTITY: no mutation, no DB read, no model call — matchGrantToClient's
// output is byte-for-byte what it is today. This is the instant kill-switch.

import type { MatchResult } from "@/lib/grants/engine";

const FLAG = "MATCH_MISSION_GATE_ENABLED";

// Signal 3. Is the model's free-text disqualify reason a MISSION / PURPOSE (Gate-4) reason — the
// client does not perform this grant's core program — as opposed to an ENTITY-TYPE / GEOGRAPHY /
// DEADLINE / AWARD-SIZE reason? The model returns prose, not a category, so this is a heuristic and
// the LEAST-SOLID leg of the bar. It is tuned to FAIL TOWARD not-suppressing: it POSITIVELY matches
// purpose / program-fit vocabulary and returns false whenever it cannot confidently read one, so an
// unrecognized or entity-only reason leaves the org free to surface / be sub-routed. It never keys on
// bare "program" (ambiguous: the GRANT's program vs the CLIENT's) or on seat-absence ("no seat" — that
// is signal 2, and firing on it would block the very specialists sub-routing is meant to catch).
// Exported for deterministic unit testing.
export function isMissionBasedReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r.trim()) return false; // no reason text → cannot confirm mission → do not suppress

  // Purpose / mission / program-fit vocabulary, each anchored so it reads on the CLIENT's fit, not on
  // the grant's own program description. (Gate 4 is literally "Purpose alignment"; the model's no-fit
  // signature is "topical/mission adjacency", "program scope/purpose aligned", "program intent".)
  const MISSION: RegExp[] = [
    /purpose\s*[- ]?\s*align/, // "Gate 4 -- Purpose alignment", "purpose not aligned"
    /program\s+(intent|scope|purpose)/, // "program scope/purpose aligned" (Gate-4 factor)
    /(topical|mission|thematic|programmatic|sector(al)?|domain)\s+adjacen/, // "topical/mission adjacency"
    /adjacency\s+only/, // the model's own NO-SEAT-IS-0 phrasing for a mission-only near-miss
    /\bmission\b[^.]{0,60}\b(mismatch|misalign|unrelated|adjacen|no overlap|different|does not|not a (fit|match))/,
    // Physical-service verbs — a Gate-4 "does not DO this work" reason — but GUARDED against a GEOGRAPHY
    // object. "does not serve the eligible region / operate in those states / provide services within
    // that county" is a Gate-3 GEOGRAPHY reason, not mission. Firing on it (a) over-suppresses a
    // geography no-fit and (b) — the live interaction with sub-routing — SUPPRESSES a prime-ineligible
    // but seat-fillable specialist whose reason merely says it serves a different area, which then makes
    // isRoutingCandidate bail and silently BLOCKS the sub-router. The negative lookahead drops the match
    // whenever a geography noun appears anywhere later in the clause (up to the next period), so it errs
    // toward NOT-suppressing (the gate's design bias) exactly when geography is in play. Reason text is
    // already lowercased, so the tokens are lowercase.
    // NB: bare `area` is deliberately NOT a geography token — "program area" / "focus area" are Gate-4
    // TOPIC vocabulary (the `outside|beyond … program area` branch below treats it as mission), so
    // excluding it would let "does not serve this program area" escape the gate. Geography "area" is
    // caught by the qualified `service area` and by `geograph\w*` ("geographic area/location").
    /\b(does|do)\s+not\b[^.]{0,60}\b(perform|provide|operate|deliver|serve|offer|engage)\b(?![^.]*\b(regions?|states?|jurisdictions?|count(y|ies)|locations?|geograph\w*|territor\w*|watershed|huc|service\s+area|catchment)\b)/,
    // Unambiguous mission phrases (no geography object possible) — kept unguarded so a mixed
    // "does not perform this kind of work ... in the region" still reads as mission via this branch.
    /\b(does|do)\s+not\b[^.]{0,60}\b(run this|do this|these activities|this kind of work|this type of work)/,
    /\bno\b[^.]{0,60}\b(relevant program|relevant work|relevant services|relevant experience|track record|programmatic (overlap|fit|nexus|connection))/,
    /\b(outside|beyond)\b[^.]{0,60}\b(mission|scope|focus|program area|core work|core services|domain|programmatic)/,
    /\bpopulation\b[^.]{0,60}\b(mismatch|does not|not served|unrelated|different|no overlap)/,
    /what\s+(this\s+)?(client|org|organization)\s+(actually\s+)?does/, // Gate-4 literal phrasing
  ];
  return MISSION.some((re) => re.test(r));
}

// The gate. Mutates `result` IN PLACE and returns void. Identity — no mutation — when the flag is off,
// when the match is already suppressed, or when any of the three signals is missing. Never lowers a
// score, never touches disqualified, never un-suppresses; it only SETS suppressed on a clean
// three-signal hit. Same in-place, code-side-clamp shape as applyHardConstraints / routeSupportingSeat.
export function applyMissionGate(result: MatchResult): void {
  if (process.env[FLAG] !== "true") return; // OFF is identity — the instant kill-switch
  if (result.suppressed) return; // already suppressed by prior code — nothing to add
  if (!result.disqualified) return; // signal 1: the model made a hard call
  const seated = !!result.seat_ref && result.seat_ref !== "NONE";
  if (seated) return; // signal 2: the model placed the client in no seat
  if (!isMissionBasedReason(result.disqualify_reason)) return; // signal 3: a mission/purpose reason

  result.suppressed = true;
  result.suppress_reason = `Mission gate: confident no-fit — ${result.disqualify_reason}`;
}
