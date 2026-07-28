import "server-only";
import { getAnthropicClient, CHEAP_MODEL } from "@/lib/anthropic";
import type { createServiceClient } from "@/lib/supabase/server";
import type { Grant } from "@/types/database";

// Need-out search for "Check a grant": staff type a NEED in their own words
// ("a grant to improve our emergency services facilities") and we surface open ledger
// grants that match, ranked, for the user to confirm and score. The client-first,
// need-driven complement to the grant-in-hand lookup (link / exact name).
//
// v1 uses LLM-assisted rerank, NOT embeddings: load the open pool and let ONE cheap-
// model call read the whole pool and pick the matches for the need (same mechanism as
// forecast-relevance's horizon rank). That gives conceptual matching ("emergency
// services facilities" ~ "public safety infrastructure") with no pgvector / embedding
// provider / out-of-band embed job. True semantic search is a later scale/cost upgrade.
//
// Isolation: a parallel READ of the ledger + one cheap LLM call. It never reads the
// occupancy pool, builds a profile, or mints a card — none of the locked active-path
// files is touched. The confirm + score half (POST /check-grant) is unchanged.

type DB = ReturnType<typeof createServiceClient>;

// Only the fields the reranker needs, kept small so a large pool fits one cheap call.
export type NeedPoolGrant = Pick<
  Grant,
  "id" | "title" | "funder" | "description" | "submission_deadline" | "status" | "deadline"
>;

export type NeedMatch = { grantId: string; reason: string };

// Cap the pool fed to the reranker. forecast-relevance ranks ~240 summaries in one
// cheap call, so a few hundred is comfortable; we bound it and LOG when it bites so a
// truncation is never silent (older grants beyond the cap simply aren't need-ranked --
// an exact name/FON still resolves via the direct ledger match in the resolve route).
const POOL_CAP = 300;

// The open, scoreable, domestic pool: fully shredded (status complete), domestic, with
// a usable description, and not past a known deadline (keep null/unparseable deadlines
// -- a data-availability drop, never an eligibility judgment). Recency-ordered.
export async function loadOpenGrantPool(db: DB, cap = POOL_CAP): Promise<NeedPoolGrant[]> {
  const { data } = await db
    .from("grants")
    .select("id, title, funder, description, submission_deadline, status, deadline")
    .eq("status", "complete")
    .or("is_domestic.is.null,is_domestic.eq.true")
    .not("description", "is", null)
    .order("ingested_at", { ascending: false })
    .limit(cap);
  const rows = (data ?? []) as NeedPoolGrant[];
  if (rows.length === cap) {
    console.warn(`[need-search] open pool hit the ${cap}-grant cap; older grants not need-ranked (exact name/FON still resolves directly).`);
  }
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter(
    (g) => (g.description ?? "").trim().length > 20 && !(g.deadline && g.deadline.slice(0, 10) < today),
  );
}

const SYSTEM = `You help GRANTED staff find U.S. domestic grants in our ledger that match a NEED an organization has described in plain words.

You are given: the organization's NEED (free text -- the PRIMARY signal), light organization context, and a numbered list of open grants (title, funder, short description).

Rank by how well each grant advances the stated NEED. Read the need as intent and direction, NOT keywords -- a grant that would serve the need counts even if it uses different words, and a grant that merely shares a broad sector does not. Use the organization context only to avoid obviously-ineligible or off-mission picks and to break ties; the NEED leads.

Return the genuine matches, most-relevant-first, each with ONE plain sentence on how it fits the need. Returning FEWER, or none, is correct -- NEVER pad to a count. Eligibility alone (that the org could apply, owns facilities, or works in a broad sector) is never on its own a reason to surface a grant. Domestic U.S. only. Copy grant_id EXACTLY from the list -- never invent one. Return via submit_matches.`;

// Rank the open pool against a free-text need. Cheap model, one call, structured tool
// output, with the same structural guards as rankForecastRelevance (every returned id
// must be in the pool, dedup, hard cap) and a deterministic token-overlap fallback on
// any LLM failure -- a coarse list beats an empty one on a transient error.
export async function rankGrantsForNeed(
  need: string,
  orgContext: string,
  pool: NeedPoolGrant[],
  cap = 8,
): Promise<NeedMatch[]> {
  if (pool.length === 0) return [];
  const byId = new Map(pool.map((g) => [g.id, g]));
  const list = pool.map((g) => ({
    grant_id: g.id,
    title: g.title,
    funder: g.funder,
    description: (g.description ?? "").slice(0, 220),
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
          name: "submit_matches",
          description: "Return the grants that match the need, most-relevant-first. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              matches: {
                type: "array",
                items: {
                  type: "object",
                  properties: { grant_id: { type: "string" }, reason: { type: "string" } },
                  required: ["grant_id", "reason"],
                },
              },
            },
            required: ["matches"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_matches" },
      messages: [
        {
          role: "user",
          content: `ORGANIZATION NEED (primary signal):\n${need}\n\nORGANIZATION CONTEXT:\n${orgContext}\n\nOPEN GRANTS:\n${JSON.stringify(list)}\n\nReturn the matches now, most-relevant-first, at most ${cap}.`,
        },
      ],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return fallbackNeedRank(need, pool, cap);
    const raw = (toolUse.input as { matches?: Array<Record<string, unknown>> }).matches ?? [];

    const seen = new Set<string>();
    const out: NeedMatch[] = [];
    for (const r of raw) {
      const id = typeof r.grant_id === "string" ? r.grant_id : "";
      if (!byId.has(id) || seen.has(id)) continue; // hallucinated / duplicate id -> drop
      seen.add(id);
      const reason =
        typeof r.reason === "string" && r.reason.trim() ? r.reason.trim().slice(0, 300) : "Matches the described need.";
      out.push({ grantId: id, reason });
      if (out.length >= cap) break;
    }
    return out;
  } catch {
    return fallbackNeedRank(need, pool, cap);
  }
}

// ── Deterministic fallback (LLM error only) ──────────────────────────────────
// Token-overlap of the need's terms vs. each grant's title + description. Orders and
// takes the top `cap`; never hard-excludes on a single field. Coarse, but beats an
// empty result on a transient LLM failure.
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "our", "was", "into", "over", "your",
  "looking", "grant", "grants", "program", "funding", "need", "want", "improve", "support", "help",
]);

function terms(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function fallbackNeedRank(need: string, pool: NeedPoolGrant[], cap: number): NeedMatch[] {
  const q = terms(need);
  if (q.size === 0) return [];
  return pool
    .map((g) => {
      const hay = terms(`${g.title ?? ""} ${g.description ?? ""}`);
      let overlap = 0;
      const hits: string[] = [];
      for (const t of q) if (hay.has(t)) { overlap++; if (hits.length < 3) hits.push(t); }
      return { g, overlap, hits };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, cap)
    .map((x) => ({ grantId: x.g.id, reason: `Overlaps your need (${x.hits.join(", ") || "topical"}).` }));
}
