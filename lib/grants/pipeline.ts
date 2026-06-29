// Shared pipeline logic — used by both manual ingest and scheduled cron
// Extracted here so both entry points run identical processing

import { createServiceClient } from "@/lib/supabase/server";
import {
  extractSimplerGovOpportunityId,
  fetchFromSimplerGovAPI,
  fetchGrantTextFromUrl,
  extractGrantData,
  matchGrantToClient,
  constructIdealApplicantProfile,
  jsPreFilter,
  looksInternational,
} from "@/lib/grants/engine";
import type { IdealApplicantProfile } from "@/types/database";
import { resolveNofoText, mergeDeepShred } from "@/lib/grants/nofo";
import { checkPastPerformance, formatUSASpendingContext } from "@/lib/grants/usaspending";

type DB = ReturnType<typeof createServiceClient>;

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
  db: DB
) {
  let extracted;
  let rawTextForStorage = rawText || "";
  let shredDepth: "full" | "summary" = "summary";
  let shredReason: string | null = null;

  const simplerGovId = url ? extractSimplerGovOpportunityId(url) : null;

  if (simplerGovId) {
    const { extracted: apiExtracted, rawJson, detail } = await fetchFromSimplerGovAPI(simplerGovId);
    extracted = apiExtracted;
    rawTextForStorage = rawJson;

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

  // Stage A (Step 3): construct the grant's ideal applicant profile from the
  // full NOFO. Only for grants that will actually be scored (domestic, not
  // hard-disqualified) and only when we have the real NOFO text (full shred) --
  // a summary is too thin to anchor a trustworthy profile. Fault-isolated.
  let idealProfile: IdealApplicantProfile | null = null;
  const willScore = isDomestic && (extracted.hard_disqualifiers?.length ?? 0) === 0;
  if (willScore && shredDepth === "full") {
    try {
      idealProfile = await constructIdealApplicantProfile(rawTextForStorage);
    } catch (err) {
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
      grant_status: extracted.grant_status,
      scoring_criteria_high_value: extracted.scoring_criteria_high_value,
      technical_burden_flags: extracted.technical_burden_flags,
      incumbent_risk: extracted.incumbent_risk,
      subaward_prohibited: extracted.subaward_prohibited,
      verification_flags: extracted.verification_flags,
      hard_disqualifiers: extracted.hard_disqualifiers,
      raw_text: rawTextForStorage.slice(0, 100000),
      is_domestic: isDomestic,
      shred_depth: shredDepth,
      shred_reason: shredReason,
      ideal_applicant_profile: idealProfile,
    })
    .eq("id", grantId);

  // International or hard-disqualified opportunities are stored (flagged) but
  // never scored — saves matching spend and honors the domestic-only mandate.
  if (!isDomestic || (extracted.hard_disqualifiers?.length ?? 0) > 0) {
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

  const { data: clients } = await db.from("clients").select("*");
  if (!clients || clients.length === 0) {
    await db.from("grants").update({ status: "complete" }).eq("id", grantId);
    return;
  }

  // Re-score the entire roster every run; the per-card dedup below keeps one.
  const toScore = clients;

  // USASpending past performance lookups for clients with unknown history
  const usaSpendingMap = new Map<string, string>();
  const clientsNeedingLookup = toScore.filter(
    (c) =>
      // Verified history is authoritative -- skip the live lookup entirely,
      // regardless of what federal_grant_history holds.
      !c.federal_history_verified &&
      (!c.federal_grant_history || c.federal_grant_history.toLowerCase() === "unknown"),
  );
  if (clientsNeedingLookup.length > 0) {
    const lookupResults = await Promise.allSettled(
      // Query the registered/parent recipient name when one is set; otherwise
      // the display name.
      clientsNeedingLookup.map((c) => checkPastPerformance(c.usaspending_search_name ?? c.name)),
    );
    lookupResults.forEach((result, i) => {
      const client = clientsNeedingLookup[i];
      if (result.status === "fulfilled") {
        usaSpendingMap.set(client.id, formatUSASpendingContext(result.value));
      }
    });
  }

  // Score clients in parallel batches of 5
  const BATCH_SIZE = 5;
  for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
    const batch = toScore.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (client) => {
        const preFilterReason = jsPreFilter(grantRow, client);
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
          const usaSpendingContext = usaSpendingMap.get(client.id);
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

          // Record EVERY attempt -- below_threshold, suppressed, and
          // disqualified included -- so calibration can see why a client did
          // not match, not just the ones that became cards.
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

          // One card per (grant, client). Look up the existing card first so a
          // re-match can refresh it, leave a human-decided one alone, OR remove
          // it when the client no longer qualifies.
          const { data: existingCard } = await db
            .from("review_cards")
            .select("id, decision")
            .eq("grant_id", grantId)
            .eq("client_id", client.id)
            .maybeSingle();

          if (qualifies) {
            const cardFields = {
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
            };
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
            // Re-score dropped this client below the surface threshold (e.g.
            // 2 -> 0 under the seat ceiling). It no longer surfaces, so remove
            // the stale un-acted card. A human-decided card (approved / passed /
            // hold) is preserved -- never silently erase a GO/NO/HOLD.
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
      }),
    );
  }

  await db.from("grants").update({ status: "complete" }).eq("id", grantId);
}
