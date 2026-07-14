// Shared pipeline logic — used by both manual ingest and scheduled cron
// Extracted here so both entry points run identical processing

import { createServiceClient } from "@/lib/supabase/server";
import {
  extractSimplerGovOpportunityId,
  fetchFromSimplerGovAPI,
  fetchGrantTextFromUrl,
  extractGrantData,
  matchGrantToClient,
  enrichMatchWithProfile,
  constructIdealApplicantProfile,
  jsPreFilter,
  looksInternational,
  grantLevelSuppressionReason,
  type MatchResult,
  type ExtractedGrant,
} from "@/lib/grants/engine";
import type { Client, Grant, IdealApplicantProfile } from "@/types/database";
import { resolveNofoText, mergeDeepShred } from "@/lib/grants/nofo";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";

type DB = ReturnType<typeof createServiceClient>;

// The review-card fields derived from an engine match. Single source of truth so
// an engine-surfaced card (runMatching) and a manual "Add to Client" card score
// to a provably-identical shape -- a manual match is indistinguishable downstream.
export function cardFieldsFromMatch(match: MatchResult) {
  return {
    fit_score: match.fit_score,
    proposed_role: match.proposed_role,
    recommended_prime: match.recommended_prime,
    why_this_org: match.why_this_org,
    concept_synopsis: match.concept_synopsis,
    description_short: match.description_short,
    draft_outreach_email: match.draft_outreach_email,
    outreach_track: match.outreach_track,
    before_you_approve: match.before_you_approve,
    inferred_fields: match.inferred_fields,
    reasoning_context: match.reasoning_context,
    factor_scores: match.factor_scores,
  };
}

// Best-effort parse of the extracted deadline text into an ISO date for the
// dashboard. The verified text is always kept in submission_deadline.
function parseDeadline(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  // Accept YYYY-MM-DD directly; otherwise let Date try, but reject garbage.
  const iso = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
  if (iso) return iso;
  const parsed = new Date(t);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export async function runPipeline(
  grantId: string,
  url: string | undefined,
  rawText: string | undefined,
  db: DB,
  // Optional hint from the caller (the cron passes the Simpler opportunity_status
  // from the search). Used to mark forecasted grants authoritatively rather than
  // relying on the extraction to infer status. Absent for manual ingest.
  opts?: { opportunityStatus?: string },
) {
  let extracted;
  let rawTextForStorage = rawText || "";
  let shredDepth: "full" | "summary" = "summary";
  let shredReason: string | null = null;
  // Grant-level skip reason (Ledger). Set only for grant-level suppressions
  // decidable without the deep shred -- currently the single-national-award cut.
  let skipReason: string | null = null;

  const simplerGovId = url ? extractSimplerGovOpportunityId(url) : null;

  if (simplerGovId) {
    const { extracted: apiExtracted, rawJson, detail } = await fetchFromSimplerGovAPI(simplerGovId);
    extracted = apiExtracted;
    rawTextForStorage = rawJson;

    // Pre-shred grant-level gate: a single national award has no realistic
    // Arkansas-anchored prime path (this mirrors the jsPreFilter global
    // suppression, but is decidable from the cheap API summary). Skip the
    // expensive deep shred + Stage A + matching entirely and record the
    // disposition -- this is the genuinely "not shredded" Ledger tier. Only the
    // awards-count cut is pre-shred-decidable; TTA/eligibility need the shred.
    // Cost optimization: if the cheap API summary already trips a grant-level
    // suppression (in practice the single-award cut -- TTA/program type are API
    // defaults pre-shred), skip the expensive deep shred + Stage A + matching.
    const preSuppression = grantLevelSuppressionReason(apiExtracted);
    if (preSuppression) {
      skipReason = preSuppression;
      shredReason = `skipped deep shred: ${preSuppression}`;
    } else {
      // Step 2: find + parse the real program NOFO and overlay analytical depth
      // (scoring rubric, delivery/convener model) the API summary never carries.
      // Fails loud: if no real NOFO validates, keep the summary shred + a reason.
      try {
        const nofo = await resolveNofoText(detail, apiExtracted.fon || "");
        shredReason = nofo.reason;
        if (nofo.text) {
          const deep = await extractGrantData(nofo.text);
          extracted = mergeDeepShred(apiExtracted, deep);
          rawTextForStorage = nofo.text;
          shredDepth = "full";
        }
      } catch (err) {
        shredDepth = "summary";
        shredReason = `deep shred failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
      }
    }
  } else {
    if (url && !rawText) {
      rawTextForStorage = await fetchGrantTextFromUrl(url);
    }
    extracted = await extractGrantData(rawTextForStorage);
    // Manual paste / direct URL is full NOFO text by definition.
    shredDepth = "full";
    shredReason = "manual full-text ingest";
  }

  const isDomestic = !looksInternational(extracted.funder, extracted.title);

  // Post-shred grant-level suppression. The award count / TTA model often
  // surfaces only from the deep shred (the API summary omits expected_number_of_
  // awards for most grants), so the pre-shred gate above can't see it. Re-check
  // on the MERGED data: if a global suppression now trips, record skip_reason so
  // it is captured on the grant (not just discovered per-client in jsPreFilter)
  // and matching is skipped below. Runs before willScore + runMatching, so a
  // suppressed grant builds no Stage A profile and wastes no per-client attempts.
  if (!skipReason) {
    skipReason = grantLevelSuppressionReason(extracted);
  }

  // A forecasted opportunity has no NOFO published yet and is not scored on first
  // pass -- matching waits for the flip-to-active re-shred (the forecasted->active
  // lifecycle; gate.ts already excludes forecasted from prospecting). Skipping
  // runMatching here is both correct AND the fix for forecasted grants getting
  // killed mid-match and left stuck in 'processing': they now land cleanly at
  // 'complete'. Mirrors the grant_status write below. The flip path passes
  // opportunityStatus 'posted', so it is unaffected and matches as intended.
  const isForecasted =
    opts?.opportunityStatus === "forecasted" || extracted.grant_status === "Forecasted";

  // Stage A (Step 3): construct the grant's ideal applicant profile from the
  // full NOFO. Only for grants that will actually be scored (domestic, not
  // hard-disqualified, not forecasted) and only when we have the real NOFO text
  // (full shred) -- a summary is too thin to anchor a trustworthy profile.
  let idealProfile: IdealApplicantProfile | null = null;
  // Capture (don't swallow) a Stage-A failure so it becomes a durable, queryable
  // record instead of a console-only log -- see migration 0048 / the Ledger
  // "Profile gap" tier. Null on success clears any stale error from a prior attempt.
  let idealProfileError: string | null = null;
  const willScore =
    isDomestic && (extracted.hard_disqualifiers?.length ?? 0) === 0 && !skipReason && !isForecasted;
  if (willScore && shredDepth === "full") {
    try {
      idealProfile = await constructIdealApplicantProfile(rawTextForStorage);
    } catch (err) {
      idealProfileError = String(err instanceof Error ? err.message : err).slice(0, 600);
      console.error("Ideal applicant profile failed for grant", grantId, err);
    }
  }

  await db
    .from("grants")
    .update({
      funder: extracted.funder,
      fon: extracted.fon,
      title: extracted.title,
      description: extracted.description,
      total_funding: extracted.total_funding,
      award_range_min: extracted.award_range_min,
      award_range_max: extracted.award_range_max,
      award_range_is_estimate: extracted.award_range_is_estimate,
      num_awards: extracted.num_awards,
      submission_deadline: extracted.submission_deadline,
      deadline: parseDeadline(extracted.submission_deadline),
      period_of_performance: extracted.period_of_performance,
      cost_share: extracted.cost_share,
      eligible_entity_types: extracted.eligible_entity_types,
      geographic_eligibility: extracted.geographic_eligibility,
      ineligible_entities: extracted.ineligible_entities,
      focus_areas: extracted.focus_areas,
      scoring_rubric: extracted.scoring_rubric,
      program_type: extracted.program_type,
      delivery_model: extracted.delivery_model,
      // A forecasted opportunity (from the cron search) is marked Forecasted
      // authoritatively; its full scoring happens when it flips to active and
      // re-shreds (the forecasted->active lifecycle, a separate change).
      grant_status:
        opts?.opportunityStatus === "forecasted" ? "Forecasted" : extracted.grant_status,
      scoring_criteria_high_value: extracted.scoring_criteria_high_value,
      technical_burden_flags: extracted.technical_burden_flags,
      incumbent_risk: extracted.incumbent_risk,
      subaward_prohibited: extracted.subaward_prohibited,
      verification_flags: extracted.verification_flags,
      hard_disqualifiers: extracted.hard_disqualifiers,
      // Assistance-listing / CFDA numbers (#107). Populated on the Simpler API path;
      // null for manual-paste / non-Simpler grants (no source to read them from).
      assistance_listings: extracted.assistance_listings ?? null,
      raw_text: rawTextForStorage.slice(0, 100000),
      is_domestic: isDomestic,
      shred_depth: shredDepth,
      shred_reason: shredReason,
      skip_reason: skipReason,
      ideal_applicant_profile: idealProfile,
      ideal_profile_error: idealProfileError,
    })
    .eq("id", grantId);

  // Grant-level-skipped, international, hard-disqualified, or forecasted
  // opportunities are stored (flagged) but never scored on first pass — saves
  // matching spend, honors the domestic-only mandate, and (for forecasted) defers
  // matching to the flip-to-active re-shred. The Ledger derives the disposition
  // from these fields.
  if (skipReason || !isDomestic || (extracted.hard_disqualifiers?.length ?? 0) > 0 || isForecasted) {
    await db.from("grants").update({ status: "complete" }).eq("id", grantId);
    return;
  }

  await runMatching(grantId, db);
}

// Observability: persist one row per (grant, client) scoring attempt -- the
// score, the reasoning, and the reason it did or did not become a card.
// Wrapped so a logging failure can never break the matching path.
type AttemptRow = {
  grant_id: string;
  client_id: string;
  outcome: string;
  fit_score?: number | null;
  suppressed?: boolean;
  suppress_reason?: string | null;
  disqualified?: boolean;
  disqualify_reason?: string | null;
  prefilter_reason?: string | null;
  error_detail?: string | null;
  result?: unknown;
};

async function recordAttempt(db: DB, row: AttemptRow) {
  try {
    const { error } = await db.from("match_attempts").insert(row);
    if (error) console.error("Failed to record match attempt:", error.message);
  } catch (err) {
    console.error("Failed to record match attempt:", err);
  }
}

/**
 * Scores ONE (grant, client) pair and reconciles its single review card:
 * jsPreFilter -> matchGrantToClient (profile-free occupancy) -> record the
 * attempt -> enrichMatchWithProfile (narrative only) -> upsert one card per
 * (grant, client): insert if new, refresh if PENDING, leave a human-DECIDED card
 * untouched, or delete a now-unqualified PENDING card. Every attempt is logged.
 *
 * Extracted verbatim from runMatching's per-client loop so the grant-centric
 * batch (one grant -> the roster) and the client-centric one-time match
 * (drainClientMatchQueue, one client -> the grant pool) score a pair through a
 * PROVABLY identical path -- the DRY-safe way to add the second orientation
 * without forking the scorer. Callers own the decided-card SPEND skip (runMatching
 * pre-skips decided clients to save the LLM call); this function is still safe to
 * call on a decided card -- it never overwrites one.
 */
export async function scoreGrantClientPair(grantRow: Grant, client: Client, db: DB) {
  const grantId = grantRow.id;

  // jsPreFilter is typed against ExtractedGrant (the shred shape); the stored
  // grants row is a structural superset, so the cast is safe -- this preserves the
  // exact runtime call runMatching made when grantRow was untyped.
  const preFilterReason = jsPreFilter(grantRow as unknown as ExtractedGrant, client);
  if (preFilterReason) {
    console.log(`Pre-filter skipped ${client.name}: ${preFilterReason}`);
    await recordAttempt(db, {
      grant_id: grantId,
      client_id: client.id,
      outcome: "prefiltered",
      prefilter_reason: preFilterReason,
    });
    return;
  }
  try {
    const usaSpendingContext = client.federal_history_verified
      ? undefined
      : formatStoredUSASpending(client.usaspending_summary);
    const match = await matchGrantToClient(grantRow, client, usaSpendingContext);
    const qualifies =
      !match.suppressed && !match.disqualified && match.fit_score >= 2;
    const outcome = match.disqualified
      ? "disqualified"
      : match.suppressed
        ? "suppressed"
        : qualifies
          ? "carded"
          : "below_threshold";

    // Record EVERY attempt -- below_threshold, suppressed, and disqualified
    // included -- so calibration can see why a client did not match, not just the
    // ones that became cards.
    await recordAttempt(db, {
      grant_id: grantId,
      client_id: client.id,
      outcome,
      fit_score: match.fit_score ?? null,
      suppressed: match.suppressed ?? false,
      suppress_reason: match.suppress_reason ?? null,
      disqualified: match.disqualified ?? false,
      disqualify_reason: match.disqualify_reason ?? null,
      result: match,
    });

    // One card per (grant, client). Look up the existing card first so a re-match
    // can refresh it, leave a human-decided one alone, OR remove it when the
    // client no longer qualifies.
    const { data: existingCard } = await db
      .from("review_cards")
      .select("id, decision")
      .eq("grant_id", grantId)
      .eq("client_id", client.id)
      .maybeSingle();

    if (qualifies) {
      // Profile-grounded narrative enrichment -- a SEPARATE call that runs only
      // for surfacing matches, cannot change the seat/score (see
      // enrichMatchWithProfile), and falls back to the Phase-1 narrative on any
      // failure. Occupancy above is already fixed and profile-free.
      const enriched = await enrichMatchWithProfile(grantRow, client, match);
      const cardFields = cardFieldsFromMatch(enriched);
      if (!existingCard) {
        await db.from("review_cards").insert({
          grant_id: grantId,
          client_id: client.id,
          ...cardFields,
          decision: "pending",
        });
      } else if (existingCard.decision === "pending") {
        await db.from("review_cards").update(cardFields).eq("id", existingCard.id);
      }
      // else: an admin already decided this card -- leave it untouched.
    } else if (existingCard && existingCard.decision === "pending") {
      // Re-score dropped this client below the surface threshold (e.g. 2 -> 0
      // under the seat ceiling). It no longer surfaces, so remove the stale
      // un-acted card. A human-decided card (approved / passed / hold) is
      // preserved -- never silently erase a GO/NO/HOLD.
      await db.from("review_cards").delete().eq("id", existingCard.id);
    }
  } catch (err) {
    console.error(`Match error for client ${client.name}:`, err);
    await recordAttempt(db, {
      grant_id: grantId,
      client_id: client.id,
      outcome: "error",
      error_detail: String(err instanceof Error ? err.message : err).slice(0, 600),
    });
  }
}

/**
 * Scores a grant against the full client roster. Re-runnable (e.g. an admin
 * "Re-match"): every client is re-scored each run and every attempt is logged
 * to match_attempts. A qualifying score keeps ONE card per (grant, client) --
 * refreshing the engine output on an un-acted card, never overwriting a card an
 * admin has already decided. Uniqueness is enforced by a DB constraint.
 */
export async function runMatching(grantId: string, db: DB) {
  const { data: grantRow } = await db
    .from("grants")
    .select("*")
    .eq("id", grantId)
    .single();
  if (!grantRow) {
    // Every error-status exit records a reason -- a status of 'error' with a
    // null error_detail is never acceptable (it leaves a silent dead-end).
    await db
      .from("grants")
      .update({ status: "error", error_detail: "Grant row not found when scoring (deleted mid-run?)" })
      .eq("id", grantId);
    return;
  }

  // EXCLUDE leads. This runs under the service role and BYPASSES RLS, so the
  // admin-only clients RLS does not protect it -- without this filter the matcher
  // would score grants against un-converted lead rows and mint cards for them.
  // Mirrors isUnconvertedLead(): keep only rows never in the pipeline (null) or
  // graduated ('converted', now real active clients).
  const { data: clients } = await db.from("clients").select("*").or(NON_LEAD_OR_FILTER);
  if (!clients || clients.length === 0) {
    await db.from("grants").update({ status: "complete" }).eq("id", grantId);
    return;
  }

  // Re-score the entire roster every run; the per-card dedup below keeps one.
  const toScore = clients;

  // Past-performance context is read from each client's STORED usaspending_summary
  // (cached at intake + the monthly sweep) -- no live USASpending call on the
  // matching hot path. A verified client is authoritative (federal_grant_history
  // wins), and a client with no cache yet scores as "unknown" rather than
  // triggering a fetch.

  // Skip human-DECIDED (grant, client) cards: the card upsert below leaves a
  // non-pending card untouched regardless of any new score, so re-scoring those
  // clients is pure wasted LLM spend. One query, up front. Pending / no-card
  // clients are NOT in this set (they still get scored); a fresh grant has no
  // cards, so the set is empty and nothing is skipped. (Prospect cards have a null
  // client_id and never match a client here.)
  const { data: existingCardsForGrant } = await db
    .from("review_cards")
    .select("client_id, decision")
    .eq("grant_id", grantId);
  const decidedClientIds = new Set(
    (existingCardsForGrant ?? [])
      .filter((c) => c.client_id && c.decision !== "pending")
      .map((c) => c.client_id as string),
  );

  // Score with a ROLLING concurrency pool (Move 1): CONCURRENCY workers each pull
  // the next client the instant they finish -- no wave barrier idling while a
  // batch's slowest call runs. Same peak concurrency, better use of the 300s
  // budget. Conservative at 8 (each match is a token-heavy Sonnet call; the SDK
  // retries 429s, but retries cost wall-clock under the cap). STILL 300s-capped --
  // Move 2 (chunking + splitting matching off ingest) is the structural fix.
  const CONCURRENCY = 8;

  async function scoreClient(client: (typeof toScore)[number]) {
    // Skip human-DECIDED cards up front to save the LLM call (scoreGrantClientPair
    // would leave them untouched anyway, but only after paying for the match).
    if (decidedClientIds.has(client.id)) return;
    await scoreGrantClientPair(grantRow, client, db);
  }

  const matchStartMs = Date.now();
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= toScore.length) return;
      await scoreClient(toScore[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toScore.length) }, worker));

  // Ceiling tripwire (Move 2): one grant's full-roster match runs inside a single
  // 300s function. Log wall-clock vs roster size EVERY run so a rising roster
  // gives us lead time to add within-grant chunking BEFORE a match ever nears the
  // cap -- rather than discovering the ceiling by hitting it. WARN past a soft
  // threshold well under 300s.
  const matchMs = Date.now() - matchStartMs;
  const timing = `[match-timing] grant ${grantId}: roster=${toScore.length} decided-skipped=${decidedClientIds.size} wallMs=${matchMs}`;
  if (matchMs > 180_000) {
    console.warn(`${timing} -- APPROACHING 300s CAP; plan within-grant chunking`);
  } else {
    console.log(timing);
  }

  await db.from("grants").update({ status: "complete" }).eq("id", grantId);
}
