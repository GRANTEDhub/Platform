import type { SupabaseClient } from "@supabase/supabase-js";
import type { PromptBlock } from "@/lib/grantbot/prompt";
import type { FocusGrant } from "@/lib/grantbot/focus-grant";
import { prospectCredibility } from "@/lib/prospects/credibility";

// The FIRM-bot grant anchor for the prospecting page ("Ask GrantBot" on /intel/[id]). A firm thread
// opened from a grant's prospecting page stores that grant's id (grantbot_conversations.focus_grant_id,
// migration 0098 — reused, no new column) exactly like the per-client anchor; this module turns that id
// into a grounding block carrying the grant's public facts PLUS the prospects we surfaced for it, so the
// staffer can ask "why did you surface X over the others?" with zero re-typing.
//
// SAME PIN AS THE PER-CLIENT BOT (the reason this is coherent): the grant id lives on the firm
// conversation row, is re-read server-side from that row every turn (firm-turn route → getFocusGrantId),
// and the block TEXT is composed HERE from the grant's own public row + the surfaced prospects — never
// from the request body. So a browser can neither re-anchor the thread mid-conversation nor inject prompt
// text; navigating away keeps the grant, because the anchor is on the row, not the page.
//
// PROSPECTS ARE DERIVED LIVE each turn (not snapshotted): if prospecting re-runs, the thread sees the
// current surfaced set, and a not-yet-prospected grant degrades to a grant-only block. FAIL-SOFT: a read
// error returns an empty prospect list (grant-only), never a crash — the same discipline as loadFocusGrant.
//
// FIRM-FRAMED, not client-framed: the firm bot has no single client (it reads the whole roster), so the
// block speaks about "the prospects we surfaced" and points the bot at its roster + tools, unlike the
// per-client focus block's "THIS client".

// Cap the prospects injected so one busy grant can't blow the per-turn context budget. Ordered
// fit-score DESC (the page's own order), so a cap keeps the strongest fits.
export const MAX_FIRM_FOCUS_PROSPECTS = 25;
// Per-prospect text clamps — the surfaced rationale is the value ("why X over the others"), but a single
// verbose card must not crowd the block. Whole bullets kept up to the count; each bullet + the concept
// clamped to a sane length.
const MAX_WHY_BULLETS = 4;
const MAX_TEXT_CHARS = 320;

// One surfaced prospect, flattened to the fields the block renders. Everything is already persisted at
// discovery time (prospects row + the review_card that ties it to the grant).
export interface SurfacedProspect {
  name: string;
  orgType: string | null;
  location: string | null;
  fitScore: number | null;
  credibility: string; // the read-time credibility pill label (Proven / Emerging / Web-surfaced)
  why: string[]; // why_this_org bullets (the surfaced rationale), clamped
  concept: string | null; // concept_synopsis, clamped
}

// The raw joined row shape: a review_card (card_type='prospect') with its prospect embedded. The FK
// embed can arrive as an object or a one-element array depending on the query planner — normalized below.
interface ProspectCardRow {
  fit_score: number | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  prospects:
    | {
        name?: string | null;
        org_type?: string | null;
        location_state?: string | null;
        location_county?: string | null;
        source_url?: string | null;
        capability_summary?: string | null;
      }
    | {
        name?: string | null;
        org_type?: string | null;
        location_state?: string | null;
        location_county?: string | null;
        source_url?: string | null;
        capability_summary?: string | null;
      }[]
    | null;
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// county + state → a short place label ("Mississippi County, AR" / "AR" / null). Both blank → null.
function formatLocation(county: string | null | undefined, state: string | null | undefined): string | null {
  const c = county?.trim() || "";
  const s = state?.trim() || "";
  if (c && s) return `${c}, ${s}`;
  return c || s || null;
}

// Map a joined row to the flat shape, dropping a row with no prospect (a defensive guard — the query
// filters card_type='prospect', which always has a prospect_id, but a race/backfill could leave the embed
// null; better to skip than to render a nameless entry).
function toSurfacedProspect(r: ProspectCardRow): SurfacedProspect | null {
  const p = Array.isArray(r.prospects) ? (r.prospects[0] ?? null) : r.prospects;
  if (!p) return null;
  const name = (p.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    orgType: p.org_type?.trim() || null,
    location: formatLocation(p.location_county, p.location_state),
    fitScore: typeof r.fit_score === "number" ? r.fit_score : null,
    credibility: prospectCredibility({ source_url: p.source_url ?? null, capability_summary: p.capability_summary ?? null }).label,
    why: (r.why_this_org ?? [])
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .slice(0, MAX_WHY_BULLETS)
      .map((b) => clamp(b, MAX_TEXT_CHARS)),
    concept: r.concept_synopsis?.trim() ? clamp(r.concept_synopsis, MAX_TEXT_CHARS) : null,
  };
}

// The surfaced prospects for a grant, most-fit first, capped. Prospects tie to a grant through the
// review_cards table (there is no grant_id on `prospects`): a prospect card is `card_type='prospect'`
// with `grant_id = <this grant>` and a `prospect_id`. FAIL-SOFT: any read error → [] (a grant-only
// block), never a throw — loadFocusGrant's contract, so runFirmTurn's user-row-then-assistant-row
// ordering is never orphaned by a focus read.
export async function loadSurfacedProspects(db: SupabaseClient, grantId: string): Promise<SurfacedProspect[]> {
  try {
    const { data } = await db
      .from("review_cards")
      .select(
        "fit_score, why_this_org, concept_synopsis, prospects(name, org_type, location_state, location_county, source_url, capability_summary)",
      )
      .eq("grant_id", grantId)
      .eq("card_type", "prospect")
      .order("fit_score", { ascending: false })
      .limit(MAX_FIRM_FOCUS_PROSPECTS);
    const rows = (data ?? []) as unknown as ProspectCardRow[];
    return rows.map(toSurfacedProspect).filter((p): p is SurfacedProspect => p !== null);
  } catch (err) {
    // A THROWN read (network-level Supabase failure, not the ordinary {data,error}) must not propagate —
    // the firm turn loads this AFTER the user row is written; fail soft to a grant-only block.
    console.error("Firm GrantBot surfaced-prospects read failed", err);
    return [];
  }
}

function renderProspect(p: SurfacedProspect, i: number): string {
  const head = [
    `${i + 1}. ${p.name}`,
    p.orgType ? `(${p.orgType})` : null,
    p.location ? `— ${p.location}` : null,
    typeof p.fitScore === "number" ? `· fit ${p.fitScore}/3` : null,
    `· ${p.credibility}`,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [`  ${head}`];
  for (const b of p.why) lines.push(`     - ${b}`);
  if (p.concept) lines.push(`     Concept: ${p.concept}`);
  return lines.join("\n");
}

// The grounding block. cacheable:false + appended AFTER the cache breakpoint (the turnBlocks seam), so a
// firm thread with no anchor is byte-identical and existing prompt caches are never busted. Present ONLY
// when a firm conversation has a focus grant. Reuses the "focus-grant" kind (a grant anchor, same as the
// per-client one) so no new PromptBlockKind is needed.
export function buildFirmFocusBlock(grant: FocusGrant, prospects: SurfacedProspect[]): PromptBlock {
  const facts = [
    `Grant: ${grant.title}`,
    grant.funder ? `Funder: ${grant.funder}` : null,
    grant.cfda ? `CFDA: ${grant.cfda}` : null,
    grant.fon ? `Opportunity number: ${grant.fon}` : null,
    grant.deadline ? `Submission deadline: ${grant.deadline}` : null,
  ]
    .filter(Boolean)
    .map((l) => `  • ${l}`)
    .join("\n");

  const prospectsSection =
    prospects.length > 0
      ? [
          "",
          `PROSPECTS WE SURFACED FOR THIS GRANT (${prospects.length}${prospects.length === MAX_FIRM_FOCUS_PROSPECTS ? "+, capped, strongest-fit first" : ""}) — candidate organizations discovered as potential applicants, most-fit first. "Credibility" is a display tier: Proven = has won this program's federal awards before; Emerging = IRS-registered nonprofit in the field, no federal history; Web-surfaced = found in public web results, unverified. Capability text is inferred and should be verified before it is stated as fact.`,
          ...prospects.map(renderProspect),
        ].join("\n")
      : "\nProspecting has NOT surfaced any prospect organizations for this grant yet. Answer about the grant itself; if the staffer asks about prospects, say none have been surfaced yet rather than inventing any.";

  return {
    kind: "focus-grant",
    source: "lib/grantbot/firm-focus.ts",
    version: "2026-09-19.1",
    cacheable: false,
    text: [
      "THIS CONVERSATION IS ANCHORED TO ONE GRANT AND THE PROSPECTS WE SURFACED FOR IT",
      "The staffer opened this thread from this grant's prospecting page, so treat every question here as being about THIS grant and these surfaced prospects unless they clearly say otherwise:",
      "",
      facts,
      prospectsSection,
      "",
      "Answer as if the staffer had named this grant — do NOT ask which grant they mean or make them re-establish the context. The full firm roster (every active client's profile) is already in your context above, along with these surfaced prospects and your read-only tools; treat them as known background.",
      "",
      "Answer the question they actually asked, at its own scope. A definitional or factual question about this grant or a surfaced org gets a direct answer — do NOT append an unrequested who-wins, fit, prime-vs-partner/sub, or go/no-go assessment they didn't ask for. When they ask for a pursuit or prospect read — who realistically wins it, which surfaced orgs are the strongest fits and why, eligibility, whether the deadline is realistic — give it fully and fast from the roster, the surfaced prospects, and your tools, keeping prime vs. partner/sub distinct and labeling award figures as estimates. If they shift to a different grant or a general question, follow them there.",
    ].join("\n"),
  };
}
