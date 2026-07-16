import "server-only";
import { getAnthropicClient, CHEAP_MODEL } from "@/lib/anthropic";
import type { createServiceClient } from "@/lib/supabase/server";
import type { Client, Grant } from "@/types/database";

// Forecasted "On the horizon" RELEVANCE rank -- Stage 1 of the forecasted-grants
// feature. Forecasted opportunities (no NOFO yet) are deliberately never profiled
// or occupancy-scored (see pipeline.ts / match-queue.ts -- untouched by this
// module). Synthesizing a seat/fit score from a pre-announcement blurb would be
// speculation dressed as a match, feeding the exact subsystem we've been burned in
// (PR #138/#140). So this is RELEVANCE ONLY: "which forecasted grants are worth
// flagging to THIS org as coming, to prepare for" -- an ordered shortlist, no
// score, no seat, no prime/partner label.
//
// The whole path is a parallel READ + one cheap LLM call. It never reads the
// occupancy pool, never builds a profile, never mints a card. That isolation is
// the active-path-unchanged guarantee: none of engine.ts / pipeline.ts /
// match-queue.ts / queue.ts / gate.ts / cron/ingest is touched.
//
// Same mechanism serves a client and a lead (a lead is a client row); the client/
// prospect distinction only exists downstream at send time.

type DB = ReturnType<typeof createServiceClient>;

// A forecasted opportunity offered to the relevance judge. Only the fields the
// judge needs, kept small so the full candidate set (~240) fits one cheap call.
export type ForecastCandidate = Pick<
  Grant,
  "id" | "title" | "funder" | "description" | "focus_areas" | "geographic_eligibility"
>;

// One entry in the ranked shortlist. `rationale` is LLM narrative (why relevant to
// THIS org), shape-validated with a deterministic title fallback -- same posture as
// enrich.ts (facts elsewhere are deterministic; only the narrative is the model's).
export type ForecastHorizonItem = {
  grantId: string;
  title: string;
  funder: string | null;
  rationale: string;
};

// Hard cap on the shortlist -- precision over recall, and it bounds a broad multi-
// sector org from surfacing a long list (mirrors the batch-send MAX_BATCH_GRANTS
// discipline). The model is also told it may return FEWER, or none.
export const HORIZON_CAP = 8;

// Funders whose grants are excluded from candidacy by DEFAULT -- GRANTED does not do
// research grants for the default roster. This is a FUNDER (agency) signal, NOT a
// fuzzy "research" classifier: on the live data the only clean signal is the funder --
// program_type is uniformly "Competitive Grant", delivery_model is defaulted to
// "direct service" (wrong for research), and the NIH mechanism prefix (R01/P30/...)
// appears in only ~38% of titles. `funder = "National Institutes of Health"` captures
// 100% of the NIH research firehose (173 of ~239 forecasted candidates) with zero
// false positives (NIH funds research institutions only). List, not a single value, so
// other pure-research agencies can be appended without touching call sites. CDC is
// deliberately ABSENT -- it mixes research (ERA) with public-health service the LLM
// judge can sort. Matched case-insensitively on the exact funder string (precision
// over recall: a partial match could catch a legitimately non-research sub-agency).
const RESEARCH_EXCLUDED_FUNDERS = ["national institutes of health"];

// Should this grant be excluded as a research funder? `optIn` (a future per-client
// flag -- the Small Business / Higher Ed opt-in checkbox; UAMS is the concrete named
// case) bypasses the exclusion so an org that DOES pursue research still sees them.
// v1 has no checkbox and no column: callers never pass optIn, so the default holds.
export function isResearchExcludedFunder(
  grant: Pick<Grant, "funder">,
  opts?: { optIn?: boolean },
): boolean {
  if (opts?.optIn) return false;
  const f = (grant.funder ?? "").trim().toLowerCase();
  return RESEARCH_EXCLUDED_FUNDERS.includes(f);
}

// The forecasted candidate pool: STILL forecasted (a flip nulls grant_status,
// dropping the grant into the real matched pool automatically -- so this set self-
// maintains with zero coupling to the flip), domestic (org rule), and with a usable
// summary. A bare listing (no description) has nothing to rank OR show, so it drops
// on DATA AVAILABILITY -- not an eligibility judgment, so it never repeats the
// MAT-PDOA silent-kill. Research funders (default: NIH) are excluded up front so the
// 72%-NIH firehose never reaches the relevance judge -- sharpening the pool (~239 ->
// ~76) and keeping the cheap model's precision high. `researchOptIn` bypasses that for
// a future opt-in org. Reads only these six columns; no profile, no rubric.
export async function loadForecastCandidates(
  db: DB,
  opts?: { researchOptIn?: boolean },
): Promise<ForecastCandidate[]> {
  const { data, error } = await db
    .from("grants")
    .select("id, title, funder, description, focus_areas, geographic_eligibility")
    .eq("grant_status", "Forecasted")
    .eq("is_domestic", true)
    .not("description", "is", null);
  if (error) throw new Error(`Forecast candidate load failed: ${error.message}`);
  return ((data ?? []) as ForecastCandidate[])
    .filter((g) => (g.description ?? "").trim().length > 20)
    .filter((g) => !isResearchExcludedFunder(g, { optIn: opts?.researchOptIn }));
}

// The org's relevance profile -- what the judge matches against. Assembled from the
// SAME raw fields the org already carries (100% populated on the roster), identical
// for a client and a lead. Deliberately EXCLUDES internal-only data (client_profile
// `gaps`, financials): relevance is programmatic/mission fit, and this text is sent
// to a model, so it stays to public-safe descriptors.
export type RelevanceProfile = { name: string; text: string };

type ProfileClient = Pick<
  Client,
  | "name"
  | "org_type"
  | "location_state"
  | "location_county"
  | "service_area"
  | "primary_funding_needs"
  | "intake_data"
  | "client_profile"
>;

export function buildRelevanceProfile(client: ProfileClient): RelevanceProfile {
  const intake = (client.intake_data ?? {}) as Record<string, unknown>;
  const profile = (client.client_profile ?? {}) as Record<string, unknown>;
  const mission =
    typeof profile.mission === "string" && profile.mission.trim()
      ? profile.mission.trim()
      : typeof intake.mission === "string"
        ? intake.mission.trim()
        : "";
  const programs = Array.isArray(intake.programs)
    ? intake.programs
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).name : null))
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const parts = [
    `Organization: ${client.name}`,
    client.org_type ? `Type: ${client.org_type.replace(/_/g, " ")}` : "",
    client.location_county || client.location_state
      ? `Location: ${[client.location_county, client.location_state].filter(Boolean).join(", ")}`
      : "",
    client.service_area?.length ? `Service area: ${client.service_area.join("; ")}` : "",
    mission ? `Mission: ${mission}` : "",
    programs.length ? `Programs: ${programs.join("; ")}` : "",
    client.primary_funding_needs?.length ? `Funding priorities: ${client.primary_funding_needs.join("; ")}` : "",
  ].filter(Boolean);
  return { name: client.name, text: parts.join("\n") };
}

const SYSTEM = `You decide which FORECASTED (not-yet-open, no application published yet) U.S. federal grants are worth flagging to a specific organization as "on the horizon" -- opportunities it could start preparing for now.

You are given the organization's profile and a numbered list of forecasted opportunities (title, funder, focus areas, geographic eligibility, short description).

Return, MOST-RELEVANT-FIRST, ONLY the opportunities that are a genuine programmatic, mission, or sector fit for THIS organization -- something it would realistically pursue. This is a RELEVANCE judgment, NOT an eligibility or fit SCORE: do NOT assign prime/partner roles, do NOT score, do NOT assess seats. Prefer PRECISION: a short, high-signal list is far better than a long one. Loose topical adjacency is NOT relevance -- exclude it.

It is correct to return FEWER than the maximum, or an EMPTY list, when few or none genuinely fit.

For each returned item: grant_id (copied EXACTLY from the provided list -- never invent one) and rationale (ONE plain sentence on why it is relevant to THIS organization's actual work). No em dashes. Domestic U.S. only.

Return via the submit_relevant tool.`;

// Rank the candidates for one org. Cheap model, one call, structured tool output.
// Guards (structural, not prompt-trust): every returned grant_id must be in the
// candidate set (a hallucinated id is dropped), dedup, hard cap. On ANY failure it
// falls back to the deterministic overlap rank -- better a coarse ordered list than
// an empty section on a transient error.
export async function rankForecastRelevance(
  profile: RelevanceProfile,
  candidates: ForecastCandidate[],
  cap: number = HORIZON_CAP,
): Promise<ForecastHorizonItem[]> {
  if (candidates.length === 0) return [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const list = candidates.map((c) => ({
    grant_id: c.id,
    title: c.title,
    funder: c.funder,
    focus_areas: c.focus_areas ?? [],
    geographic_eligibility: c.geographic_eligibility,
    description: (c.description ?? "").slice(0, 300),
  }));

  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM,
      tools: [
        {
          name: "submit_relevant",
          description: "Return the relevant forecasted opportunities, most-relevant-first. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              relevant: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    grant_id: { type: "string" },
                    rationale: { type: "string" },
                  },
                  required: ["grant_id", "rationale"],
                },
              },
            },
            required: ["relevant"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_relevant" },
      messages: [
        {
          role: "user",
          content: `ORGANIZATION PROFILE:\n${profile.text}\n\nFORECASTED OPPORTUNITIES:\n${JSON.stringify(list)}\n\nReturn the relevant ones now, most-relevant-first, at most ${cap}.`,
        },
      ],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return fallbackRank(profile, candidates, cap);
    const raw = (toolUse.input as { relevant?: Array<Record<string, unknown>> }).relevant ?? [];

    const seen = new Set<string>();
    const items: ForecastHorizonItem[] = [];
    for (const r of raw) {
      const id = typeof r.grant_id === "string" ? r.grant_id : "";
      const cand = byId.get(id);
      if (!cand || seen.has(id)) continue; // hallucinated / duplicate id -> drop
      seen.add(id);
      const rationale =
        typeof r.rationale === "string" && r.rationale.trim()
          ? r.rationale.trim().slice(0, 240)
          : cand.title ?? "Forecasted opportunity";
      items.push({ grantId: id, title: cand.title ?? "Forecasted opportunity", funder: cand.funder, rationale });
      if (items.length >= cap) break;
    }
    return items;
  } catch {
    return fallbackRank(profile, candidates, cap);
  }
}

// Public entry: load candidates + rank for this org. Stage 2 (the alert draft) will
// call this and bake the result into the saved draft so preview == sent. Nothing
// here reads or writes the occupancy pool.
export async function getForecastHorizon(
  db: DB,
  client: ProfileClient,
  opts?: { cap?: number; researchOptIn?: boolean },
): Promise<ForecastHorizonItem[]> {
  const cap = opts?.cap ?? HORIZON_CAP;
  const candidates = await loadForecastCandidates(db, { researchOptIn: opts?.researchOptIn });
  return rankForecastRelevance(buildRelevanceProfile(client), candidates, cap);
}

// ── Deterministic fallback (LLM error only) ──────────────────────────────────
// A soft token-overlap rank: org profile terms vs. the grant's title + focus areas
// + description. It ONLY orders and takes the top `cap` -- it never hard-excludes on
// any single field, so a lossy field cannot silently drop an eligible grant (the
// MAT-PDOA rule). Used solely when the cheap call throws / returns no tool use; a
// coarse ranked list beats an empty section on a transient failure.
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "across", "their",
  "other", "into", "over", "grant", "program", "federal", "funding", "support", "services",
]);

function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function fallbackRank(profile: RelevanceProfile, candidates: ForecastCandidate[], cap: number): ForecastHorizonItem[] {
  const terms = tokenize(profile.text);
  return candidates
    .map((c) => {
      const hay = tokenize(`${c.title ?? ""} ${(c.focus_areas ?? []).join(" ")} ${c.description ?? ""}`);
      let overlap = 0;
      const hits: string[] = [];
      for (const t of terms) if (hay.has(t)) { overlap++; if (hits.length < 3) hits.push(t); }
      return { c, overlap, hits };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, cap)
    .map((s) => ({
      grantId: s.c.id,
      title: s.c.title ?? "Forecasted opportunity",
      funder: s.c.funder,
      rationale: `Overlaps your focus areas (${s.hits.join(", ") || "topical"}).`,
    }));
}
