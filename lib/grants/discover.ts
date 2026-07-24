// Track 2 discovery — the IntellEngine daily move, in code: read a grant's
// existing ideal applicant profile, run one Brave search for fitting non-client
// orgs (Arkansas first), extract real candidates GROUNDED in the actual results,
// score them with the existing engine, and write prospects + prospect cards for
// the qualifiers. Never re-shreds. Fails gracefully like USASpending.
//
// Hallucination guards (both structural, not prompt trust):
//   1. source_url must be one Brave actually returned (code check below).
//   2. prospects.source_url is NOT NULL (the schema; a sourceless org cannot exist).
//
// Analysis stays internal: prospect cards carry the scored reasoning for review,
// but draft_outreach_email is intentionally NOT written -- the eventual hook
// email is built downstream from the org record, never from the scored draft.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { matchGrantToClient } from "@/lib/grants/engine";
import { braveSearch } from "@/lib/grants/brave";
import { createServiceClient } from "@/lib/supabase/server";
import type { Grant, Client } from "@/types/database";

type DB = ReturnType<typeof createServiceClient>;

export interface DiscoverResult {
  ok: boolean;
  reason?: string;
  searched?: string;
  candidates?: number; // orgs the model proposed
  grounded?: number; // candidates that survived the URL + dedup guards
  carded?: number; // qualifiers (fit >= 2) written as prospect cards
}

const EXTRACT_SYSTEM = `You identify real candidate ORGANIZATIONS from web search results for GRANTED, a U.S. grant consulting firm looking for non-client orgs (Arkansas first) that could pursue a federal grant.

You are given a grant's ideal applicant profile and a list of REAL search results (title, url, description). Identify organizations that plausibly fit the profile AND that actually appear in the results.

HARD RULES:
- Only return an organization that appears in the provided results. NEVER invent one.
- For each org, source_url MUST be copied EXACTLY from the result it came from. Do not modify, shorten, or fabricate URLs.
- Prefer Arkansas organizations. Exclude government grant pages, news articles, directories, and the funder itself -- you want candidate APPLICANT orgs, not coverage of the grant.
- capability_summary: 1-2 sentences on what the org does, drawn only from the result text.
- Do not use em dashes.

Return via the submit_candidates tool. Return an empty list if no real candidate orgs appear.`;

// Normalize an org name for dedup: lowercase, strip punctuation, collapse
// whitespace, drop a leading "the" and trailing legal/common suffixes (inc, llc,
// corp, co, foundation). Catches "Heartland Forward" vs "Heartland Forward, Inc."
// across two result snippets, and tightens client/existing-prospect matching
// against DBA/punctuation variance.
export function normalizeOrgName(name: string | null | undefined): string {
  let s = (name ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^the\s+/, "");
  let prev;
  do {
    prev = s;
    s = s.replace(/\s+(inc|llc|corp|co|foundation)$/, "").trim();
  } while (s !== prev);
  return s;
}

// Public entry: guard discovery so a single failure (a malformed grant, an Anthropic
// hiccup, a bad API response) degrades to a clean { ok:false, reason } the caller renders
// as a soft error -- never a 500 that takes down the whole request. The route already
// maps ok:false to a surfaced message, so this needs no caller change. The per-candidate
// scoring loop in runDiscovery is already resilient (one bad candidate returns 0, never
// throws); this wraps the remaining pre-loop throw sources -- chiefly the extraction LLM
// call. Logged loudly so a real underlying problem stays visible even though the user
// just sees "no prospects / try again".
export async function discoverProspects(grantId: string, db: DB): Promise<DiscoverResult> {
  try {
    return await runDiscovery(grantId, db);
  } catch (err) {
    console.error(`[discoverProspects] unexpected failure for grant ${grantId}:`, err);
    return {
      ok: false,
      reason: `Prospect discovery hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runDiscovery(grantId: string, db: DB): Promise<DiscoverResult> {
  const { data: grant } = await db.from("grants").select("*").eq("id", grantId).single<Grant>();
  if (!grant) return { ok: false, reason: "Grant not found" };
  if (!grant.is_domestic) return { ok: false, reason: "International grant -- excluded by policy" };
  const profile = grant.ideal_applicant_profile;
  if (!profile) return { ok: false, reason: "No ideal applicant profile -- re-shred the grant first" };

  // One lean, Arkansas-first query built from the profile.
  const sector = (grant.focus_areas || [])[0] || "";
  const query = [profile.core_funded_role, sector, "Arkansas organization"].filter(Boolean).join(" ");

  const search = await braveSearch(query);
  if (!search.ok) return { ok: false, reason: `Search failed: ${search.note ?? "unknown"}`, searched: query };
  if (search.results.length === 0) {
    return { ok: true, searched: query, candidates: 0, grounded: 0, carded: 0 };
  }

  // Extract candidate orgs grounded in the real results.
  const anthropic = getAnthropicClient();
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: EXTRACT_SYSTEM,
    tools: [
      {
        name: "submit_candidates",
        description: "Return candidate orgs found in the search results. Call exactly once.",
        input_schema: {
          type: "object",
          properties: {
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  org_type: { type: "string" },
                  location_state: { type: "string" },
                  location_county: { type: "string" },
                  source_url: { type: "string" },
                  capability_summary: { type: "string" },
                },
                required: ["name", "source_url", "capability_summary"],
              },
            },
          },
          required: ["candidates"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_candidates" },
    messages: [
      {
        role: "user",
        content: `IDEAL APPLICANT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nSEARCH RESULTS:\n${search.results
          .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`)
          .join("\n\n")}`,
      },
    ],
  });
  const toolUse = resp.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { ok: true, searched: query, candidates: 0, grounded: 0, carded: 0 };
  }
  const extracted = ((toolUse.input as { candidates?: Array<Record<string, string>> }).candidates ?? []);

  // GUARD 1 (code): source_url must be EXACTLY one Brave returned (normalized).
  // A plausible-but-unreturned URL is rejected -- the model cannot pass through
  // a link we did not actually fetch. (GUARD 2 is the NOT NULL column.)
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const resultUrls = new Set(search.results.map((r) => norm(r.url)));

  // Dedup: skip orgs that match an existing client (we do not prospect our own
  // roster) or a prospect already carded on this grant; dedup within the run.
  const { data: clients } = await db.from("clients").select("name");
  const clientNames = new Set((clients ?? []).map((c) => normalizeOrgName(c.name)));
  const { data: existingCards } = await db
    .from("review_cards")
    .select("prospects(name)")
    .eq("grant_id", grantId)
    .eq("card_type", "prospect");
  const existingProspectNames = new Set(
    (existingCards ?? []).flatMap(
      (r: { prospects: { name: string }[] | { name: string } | null }) => {
        const p = r.prospects;
        if (!p) return [];
        return Array.isArray(p)
          ? p.map((x) => normalizeOrgName(x.name))
          : [normalizeOrgName(p.name)];
      },
    ),
  );

  const seen = new Set<string>();
  const grounded = extracted
    .filter((c) => c.source_url && resultUrls.has(norm(c.source_url)))
    .filter((c) => {
      const n = normalizeOrgName(c.name);
      if (!n || clientNames.has(n) || existingProspectNames.has(n) || seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .slice(0, 8); // cap discovery cost

  // Score each grounded candidate with the existing engine; write a prospect +
  // prospect card for qualifiers (fit >= 2). Bounded-concurrent batches of 5
  // (mirrors runMatching) so a full 8-candidate run finishes well under the
  // function's maxDuration instead of scoring sequentially and timing out.
  //
  // Concurrency safety: all dedup (client names, already-carded prospects,
  // intra-run same-org collapse) is resolved by the sequential pre-filter that
  // built `grounded` above. Every grounded entry is a DISTINCT org, so the
  // parallel section is pure independent per-item work -- each task mints its own
  // fresh prospect row + one card and shares no mutable state. `carded` is summed
  // from returned values, never mutated across tasks.
  const BATCH_SIZE = 5;
  let carded = 0;
  for (let i = 0; i < grounded.length; i += BATCH_SIZE) {
    const batch = grounded.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (c): Promise<number> => {
        try {
          const match = await matchGrantToClient(grant, prospectAsClient(c));
          if (match.suppressed || match.disqualified || match.fit_score < 2) return 0;

          const { data: prospect, error: pErr } = await db
            .from("prospects")
            .insert({
              name: c.name,
              org_type: c.org_type ?? null,
              location_state: c.location_state ?? null,
              location_county: c.location_county ?? null,
              source_url: c.source_url, // NOT NULL: schema-enforced hallucination guard
              capability_summary: c.capability_summary ?? null,
            })
            .select("id")
            .single();
          if (pErr || !prospect) {
            console.error("Prospect insert failed for", c.name, pErr);
            return 0;
          }

          const { error: cErr } = await db.from("review_cards").insert({
            grant_id: grantId,
            prospect_id: prospect.id,
            card_type: "prospect",
            fit_score: match.fit_score,
            proposed_role: match.proposed_role,
            recommended_prime: match.recommended_prime,
            why_this_org: match.why_this_org,
            concept_synopsis: match.concept_synopsis,
            description_short: match.description_short,
            outreach_track: match.outreach_track,
            before_you_approve: match.before_you_approve,
            inferred_fields: match.inferred_fields,
            reasoning_context: match.reasoning_context,
            decision: "pending",
            // draft_outreach_email intentionally omitted (stays null): analysis
            // stays internal; the hook email is built downstream from the record.
          });
          if (cErr) {
            console.error("Prospect card insert failed for", c.name, cErr);
            return 0;
          }
          return 1;
        } catch (err) {
          console.error("Prospect scoring failed for", c.name, err);
          return 0;
        }
      }),
    );
    carded += results.reduce((sum, n) => sum + n, 0);
  }

  return { ok: true, searched: query, candidates: extracted.length, grounded: grounded.length, carded };
}

// Adapt a discovered prospect into the Client shape the scorer reads. Most
// fields are unknown for a prospect; capability_summary (from the web result)
// carries what the org does. engagement_tier null signals "not an existing
// client", which the matching prompt reads as a Track 2 prospect.
function prospectAsClient(c: Record<string, string>): Client {
  const now = new Date().toISOString();
  return {
    id: "prospect-candidate",
    name: c.name,
    org_type: c.org_type ?? null,
    status: "prospect",
    seat_limit: 1, // not a real client; portal seats are irrelevant to scoring
    engagement_tier: null,
    primary_contact_name: null,
    primary_contact_email: null,
    primary_contact_phone: null,
    location_city: null,
    location_county: c.location_county ?? null,
    location_state: c.location_state ?? null,
    service_area: c.location_state ? [c.location_state] : null,
    retainer_hours: null,
    contract_start: null,
    contract_end: null,
    next_step: null,
    notes: null,
    rucc_codes: null,
    annual_budget: null,
    primary_funding_needs: null,
    project_stage: null,
    match_cost_share_capacity: null,
    federal_grant_history: null,
    usaspending_search_name: null,
    federal_history_verified: false,
    usaspending_summary: null,
    usaspending_checked_at: null,
    sam_uei_status: null,
    uei: null,
    sam_matched_name: null,
    sam_registration_status: null,
    sam_expiration_date: null,
    sam_checked_at: null,
    known_constraints: c.capability_summary
      ? `Capability (inferred from web search): ${c.capability_summary}`
      : null,
    matching_rules: null,
    hard_constraints: null,
    // Lead-pipeline fields (migration 0025): a discovered prospect is not a lead
    // until it is explicitly promoted, so these are all null/false here.
    pipeline_stage: null,
    lead_source: null,
    account_manager_id: null,
    intake_data: null,
    client_profile: null,
    initial_match_status: null,
    match_locked_at: null,
    needs_review: false,
    research_opt_in: false,
    account_managed: false, // not a real client; the SME gate is irrelevant to scoring
    archived_reason: null,
    contract_status: null,
    contract_signed_at: null,
    unsubscribed_at: null,
    discovery_booked_at: null,
    intake_sent_at: null,
    stripe_customer_id: null,
    converted_at: null,
    created_at: now,
    updated_at: now,
  };
}
