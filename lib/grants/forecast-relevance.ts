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
  opts?: { researchOptIn?: boolean; clientId?: string },
): Promise<ForecastCandidate[]> {
  const { data, error } = await db
    .from("grants")
    .select("id, title, funder, description, focus_areas, geographic_eligibility")
    .eq("grant_status", "Forecasted")
    .eq("is_domestic", true)
    .not("description", "is", null);
  if (error) throw new Error(`Forecast candidate load failed: ${error.message}`);
  let candidates = ((data ?? []) as ForecastCandidate[])
    .filter((g) => (g.description ?? "").trim().length > 20)
    .filter((g) => !isResearchExcludedFunder(g, { optIn: opts?.researchOptIn }));

  // Horizon Reject gate (migration 0053). Drop the grants THIS client has rejected
  // for the horizon -- applied to the CANDIDATE SET, i.e. BEFORE rankForecastRelevance
  // ranks and caps to HORIZON_CAP. That ordering is load-bearing: rejecting the
  // visible #1 lets the next-best candidate (#9) refill into the top-N, so the client
  // always sees up to the cap of non-rejected forecasts rather than the list shrinking.
  // Read ONLY here (the shared forecasted render path -- web view AND emailed PDF),
  // NEVER as a review_cards decision: a forecast->posted flip nulls grant_status, so
  // the grant drops out of the query above and this reject is simply never consulted
  // for it -> fresh-look-on-flip with zero coupling to the flip handler.
  if (opts?.clientId) {
    const { data: rejects, error: rErr } = await db
      .from("forecast_rejections")
      .select("grant_id")
      .eq("client_id", opts.clientId);
    if (rErr) throw new Error(`Forecast reject load failed: ${rErr.message}`);
    if (rejects && rejects.length > 0) {
      const rejected = new Set((rejects as { grant_id: string }[]).map((r) => r.grant_id));
      candidates = candidates.filter((g) => !rejected.has(g.id));
    }
  }
  return candidates;
}

// The org's relevance profile -- what the judge matches against. Assembled from the
// SAME raw fields the org already carries (100% populated on the roster), identical
// for a client and a lead. Deliberately EXCLUDES internal-only data (client_profile
// `gaps`, financials): relevance is programmatic/mission fit, and this text is sent
// to a model, so it stays to public-safe descriptors.
export type RelevanceProfile = { name: string; text: string };

type ProfileClient = Pick<
  Client,
  | "id"
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
    client.primary_funding_needs?.length
      ? `Stated funding priorities (what they have told us they want): ${client.primary_funding_needs.join("; ")}`
      : "",
  ].filter(Boolean);
  return { name: client.name, text: parts.join("\n") };
}

const SYSTEM = `You decide which FORECASTED (not-yet-open, no application published yet) U.S. federal grants are worth flagging to a specific organization as "on the horizon" -- opportunities it could start preparing for now.

You are given the organization's profile and a numbered list of forecasted opportunities (title, funder, focus areas, geographic eligibility, short description).

The organization's STATED funding priorities are the PRIMARY relevance signal -- weight them above everything else. Read them as the org's DIRECTION and intent, not as keywords: a grant that advances what they are clearly trying to do is relevant even if it uses different words, and a grant that merely shares a broad sector is not.

ELIGIBILITY IS NEVER A HOOK. That an organization could apply, owns or operates facilities, serves the public, or works in a broad shared sector is NEVER, on its own, a reason to surface a grant. Do NOT launder a grant into relevance through a generic mandate phrase like "community facilities," "public services," or "infrastructure." Those are not hooks.

DOMAIN GATE. A HOUSING grant (production, rehab, counseling, home modification, vouchers), a CLINICAL or PUBLIC-HEALTH grant, or a HUMAN-SERVICES grant is relevant ONLY IF that specific domain -- housing, health, human services -- is among the org's STATED priorities. If the org has not stated that domain, DROP the grant. For a county whose stated priorities are roads, public safety, and flood mitigation, a Healthy Homes / home-modification / housing-counseling grant DROPS (no stated housing priority); for an org that states workforce housing, the same housing grant SURFACES.

SAFETY CARVE-OUT -- the ONE narrow exception to the domain gate. Environmental-hazard or life-safety REMEDIATION that any organization of that kind would obviously pursue -- for a local government: lead or mold hazard remediation, emergency response and preparedness, community policing -- MAY surface even without a stated priority, because it is a universal safety concern, not entry into a new program domain. This is a SHORT, named exception, not a general "core mandate" allowance: housing PRODUCTION, health PROGRAMS, or service delivery are NOT safety remediation and get no exception. When unsure whether something is safety remediation or a program in a new domain, treat it as a program and DROP it.

Otherwise, surface a forecast, most-relevant-first, when it advances one of the org's stated priorities or the direction they clearly imply. Stay BROAD BUT HONEST within these rules: surface every grant that advances a stated priority (read generously as direction, not keywords) plus the narrow safety carve-out, and drop everything else. When stated priorities are sparse, still read direction from the org's type and mission; do not under-surface a genuine stated-direction fit for lack of a keyword echo. Returning FEWER, or an honest near-empty list, is correct -- NEVER pad to a count. This is a RELEVANCE judgment, NOT an eligibility or fit SCORE: no prime/partner roles, no score, no seats.

For each returned item, provide grant_id (copied EXACTLY from the provided list -- never invent one) and a rationale that is HONEST ABOUT THE STRENGTH OF FIT -- one plain sentence that neither undersells nor oversells:
- A stated-priority fit: name the priority it advances.
- A safety carve-out item (surfaced without a stated priority): say so plainly, e.g. "lead-hazard remediation, a universal public-safety concern for any county, though not among this county's stated priorities."
- A partial fit within a stated domain: say so and name the gap.
NEVER claim a fit dimension the grant does not have (do not describe a housing-rehab grant as "infrastructure and hazard mitigation"). Do not dress a stretch as a strong match, and do NOT surface a grant just to disclose it is a stretch -- if it fails the rules above, DROP it, never surface-with-caveat. Keep the rationale to ONE complete sentence, roughly 35 words maximum, so it never trails off. No em dashes. Domestic U.S. only.

Return via the submit_relevant tool.`;

// Clamp a rationale for a client-facing document WITHOUT cutting mid-word. The old
// hard slice(0, 240) truncated to "...not a direct programmat" -- broken in a PDF.
// The prompt already asks for one ~35-word sentence, so this rarely fires; when it
// does it ends at a full sentence (preferred) or a word boundary + ellipsis, never
// mid-word. Generous bound (360) leaves an honest adjacency rationale room to finish.
function clampRationale(s: string, max = 360): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceEnd >= max * 0.5) return slice.slice(0, sentenceEnd + 1); // end on a full sentence
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).replace(/[,;:]+$/, "") + "…";
}

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
          ? clampRationale(r.rationale)
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
  const candidates = await loadForecastCandidates(db, {
    researchOptIn: opts?.researchOptIn,
    clientId: client.id, // apply this client's Horizon Reject gate before rank/cap
  });
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
