// Shared pipeline logic — used by both manual ingest and scheduled cron
// Extracted here so both entry points run identical processing

import { createServiceClient } from "@/lib/supabase/server";
import {
  extractSimplerGovOpportunityId,
  fetchFromSimplerGovAPI,
  fetchGrantTextFromUrl,
  extractGrantData,
  matchGrantToClient,
  jsPreFilter,
  looksInternational,
} from "@/lib/grants/engine";
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

  const simplerGovId = url ? extractSimplerGovOpportunityId(url) : null;

  if (simplerGovId) {
    const { extracted: apiExtracted, rawJson } = await fetchFromSimplerGovAPI(simplerGovId);
    extracted = apiExtracted;
    rawTextForStorage = rawJson;
  } else {
    if (url && !rawText) {
      rawTextForStorage = await fetchGrantTextFromUrl(url);
    }
    extracted = await extractGrantData(rawTextForStorage);
  }

  const isDomestic = !looksInternational(extracted.funder, extracted.title);

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
      raw_text: rawTextForStorage.slice(0, 100000),
      is_domestic: isDomestic,
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

/**
 * Scores a grant against the client roster and writes review cards for fit ≥ 2.
 * Idempotent: clients that already have a card for this grant are skipped, so it
 * is safe to call again to fill in matches (e.g. an admin "Re-match"). Used by
 * both the ingest pipeline and the re-match endpoint.
 */
export async function runMatching(grantId: string, db: DB) {
  const { data: grantRow } = await db
    .from("grants")
    .select("*")
    .eq("id", grantId)
    .single();
  if (!grantRow) {
    await db.from("grants").update({ status: "error" }).eq("id", grantId);
    return;
  }

  const { data: clients } = await db.from("clients").select("*");
  if (!clients || clients.length === 0) {
    await db.from("grants").update({ status: "complete" }).eq("id", grantId);
    return;
  }

  // Don't re-score clients that already have a card for this grant.
  const { data: existingCards } = await db
    .from("review_cards")
    .select("client_id")
    .eq("grant_id", grantId);
  const alreadyCarded = new Set(
    (existingCards ?? []).map((c: { client_id: string | null }) => c.client_id),
  );
  const toScore = clients.filter((c) => !alreadyCarded.has(c.id));

  // USASpending past performance lookups for clients with unknown history
  const usaSpendingMap = new Map<string, string>();
  const clientsNeedingLookup = toScore.filter(
    (c) => !c.federal_grant_history || c.federal_grant_history.toLowerCase() === "unknown",
  );
  if (clientsNeedingLookup.length > 0) {
    const lookupResults = await Promise.allSettled(
      clientsNeedingLookup.map((c) => checkPastPerformance(c.name)),
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
          return;
        }
        try {
          const usaSpendingContext = usaSpendingMap.get(client.id);
          const match = await matchGrantToClient(grantRow, client, usaSpendingContext);
          if (!match.suppressed && !match.disqualified && match.fit_score >= 2) {
            await db.from("review_cards").insert({
              grant_id: grantId,
              client_id: client.id,
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
              decision: "pending",
            });
          }
        } catch (err) {
          console.error(`Match error for client ${client.name}:`, err);
        }
      }),
    );
  }

  await db.from("grants").update({ status: "complete" }).eq("id", grantId);
}
