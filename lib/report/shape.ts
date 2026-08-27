// Shared view-model for the Grant Report — the client-facing "roadmap" surface.
// One shaping layer feeds BOTH the client portal and (later) the staff account-
// manager view, so the two render identically off the same decision data
// (review_cards + the joined grant). Pure + presentation-agnostic: no JSX here,
// just the derived shape and the small honest formatters the rows/detail need.
import type {
  CardDecision,
  ConceptProposal,
  ConceptProposalStatus,
  FactorRating,
  FactorScores,
  Grant,
  PursuitPath,
  ReviewCard,
} from "@/types/database";
import { formatAwardRange, formatDeadlineShort, compactCostShare } from "@/lib/grants/format";
import { resolveFit, type QaVerdictView } from "@/lib/report/qa-override";

export type FactorKey = keyof FactorScores;

// Client-legible labels for the engine's six sub-scores. Same factors staff see;
// worded for a client audience.
export const FACTOR_LABELS: Record<FactorKey, string> = {
  mission: "Mission fit",
  eligibility: "Eligibility",
  geographic: "Geographic",
  seat_role: "Role fit",
  program_history: "Track record",
  cost_share: "Match / budget",
};

// Order the detail renders the full breakdown in. The compact list row shows the
// first three (the most client-legible signals); the rest live in the detail.
export const ALL_FACTORS: FactorKey[] = [
  "mission",
  "eligibility",
  "geographic",
  "seat_role",
  "program_history",
  "cost_share",
];
export const ROW_FACTORS: FactorKey[] = ["mission", "eligibility", "geographic"];

export interface FitBand {
  label: string;
  // Ring/label tone; mapped to brand classes by the renderer.
  tone: "strong" | "good" | "fair";
}

// Fit is the engine's 1–3 ordinal — never a percentage. Labels match the staff
// review bands so client and account manager read the same word for the same score.
export const FIT_BAND: Record<1 | 2 | 3, FitBand> = {
  3: { label: "Strong fit", tone: "strong" },
  2: { label: "Conditional", tone: "good" },
  1: { label: "Weak", tone: "fair" },
};

export interface FactorView {
  key: FactorKey;
  label: string;
  rating: FactorRating | null; // null = card scored before per-factor sub-scores shipped
  rationale: string | null;
}

// Mark + tone for a factor rating. Data only (tailwind class strings) so both the
// client-side list and the server-side detail render it without duplicating logic.
export function factorDisplay(rating: FactorRating | null): {
  mark: "check" | "approx" | "dash";
  className: string;
  word: string;
} {
  switch (rating) {
    case "strong":
      return { mark: "check", className: "text-emerald-600", word: "Strong" };
    case "moderate":
      return { mark: "approx", className: "text-amber-500", word: "Moderate" };
    case "weak":
      return { mark: "approx", className: "text-brand-orange", word: "Limited" };
    default:
      return { mark: "dash", className: "text-muted-foreground", word: "Not yet assessed" };
  }
}

export function factorViews(scores: FactorScores | null, keys: FactorKey[] = ALL_FACTORS): FactorView[] {
  return keys.map((key) => {
    const fs = scores?.[key] ?? null;
    return {
      key,
      label: FACTOR_LABELS[key],
      rating: fs?.rating ?? null,
      rationale: fs?.rationale ?? null,
    };
  });
}

// Whole days until the deadline (negative once past). null when the date is
// rolling / TBD / unparseable — mirrors the grant-detail sublabel logic.
export function deadlineDaysLeft(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s || !/\d{4}/.test(s)) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

// Whether a deadline is close enough to block a terminal action: today or already gone.
//
// DELIBERATELY WIDER THAN "CLOSED" (`daysLeft < 0`), which drives the Grant Report's
// closed rows, the header stat and the bulk archive sweep. A grant due TODAY is still
// winnable -- federal deadlines carry a cut-off time we do not store -- so it warns but is
// never archivable. Two thresholds, one of them intentionally not the other.
//
// LIVES HERE, NOT BESIDE THE DIALOG THAT USES IT. It was exported from
// components/report/overdue-gate.tsx, which carries "use client" -- and every export of a
// client module becomes a client REFERENCE, so the server component calling it threw on
// every request ("server-side exception", digest only, no build error). Shipping it next
// to deadlineDaysLeft keeps it callable from both sides, which is what it needs to be.
export function isOverdue(daysLeft: number | null): boolean {
  return daysLeft !== null && daysLeft <= 0;
}

export interface ReportItem {
  id: string; // review_card id — the link target
  grantId: string | null;
  title: string;
  funder: string | null;
  // NULLABLE, and the null is real: review_cards.fit_score has no NOT NULL
  // constraint (0001_init) and a card can exist unscored. This used to coerce to 1,
  // which rendered an unscored grant as a confident "Weak" — on the client's own
  // Grant Report as well as staff's — and dragged the average-fit rollup down with it.
  // Every consumer must handle null rather than the shape inventing a floor.
  fitScore: 1 | 2 | 3 | null;
  band: FitBand | null;
  role: string | null; // proposed_role (Prime / Partner) — a real prime-vs-partner signal
  focusAreas: string[];
  awardRange: string;
  awardIsEstimate: boolean;
  deadlineLabel: string;
  deadlineDaysLeft: number | null;
  deadlineSoon: boolean; // within 30 days (and not past)
  decision: CardDecision;
  rowFactors: FactorView[];
  // Richer fields for the swipe card (populated only when the query selects them;
  // the list leaves them null). Kept optional so the list row shape is unaffected.
  totalAvailable: string | null; // grants.total_funding (free text)
  matchRequired: string; // compact cost-share, e.g. "25%" / "None"
  purpose: string | null; // description, HTML-stripped + truncated
  eligibleTypes: string[]; // cleaned eligible entity types (first few)
  geography: string | null; // geographic_eligibility
  programIdea: string | null; // concept_synopsis (client-facing narrative)
  // Client Grant Alert card fields (populated only when the query selects them). The
  // category pill is the first focus area; nofoNumber is the funding opportunity number
  // (grants.fon); sourceUrl backs the "Read full NOFO" link (grants.source_url).
  category: string | null;
  nofoNumber: string | null;
  sourceUrl: string | null;
  // Staff-only read visibility into the account-manager gate (0059) -- true once
  // staff has released this card to the client. Only meaningful when the query
  // selected sme_released_at (the staff roadmap list); false/absent everywhere
  // else, including the client's own portal.
  smeReleased: boolean;
  // How the client chose to pursue (migration 0061). null = pending a pursuit
  // decision (the Grant Report's default view); set = routed (in progress).
  pursuitPath: PursuitPath | null;
  // Concept-proposal reveal state for the client-facing list surfaces. Populated
  // by the page (via withConcept) AFTER shaping, since it comes from a separate
  // admin-only table -- toReportItem leaves it undefined, so staff surfaces that
  // don't stamp it render no reveal.
  concept?: ConceptReveal;
  // Has THIS SIDE read the row. Resolved from staff_read_at or client_read_at by the
  // ReadSide passed to toReportItems -- never both, and the renderer is not told which
  // column it came from. See ReadSide for why that indirection is the point.
  read: boolean;
  // The IntellEngine QA badge for this card (migration 0088), or null when no QA verdict is in effect.
  // `fitScore`/`rowFactors` above ALREADY reflect an applied+fresh override (resolveFit) — this field
  // only drives the badge/sources UI. Populated only when the query selected the qa_* columns; a list
  // that does not select them shapes to null, i.e. today's display.
  qa: QaVerdictView | null;
}

// Which dashboard is being rendered, and therefore which read column is the truth.
// review_cards carries staff_read_at and client_read_at independently (migration
// 0070) because the console and the portal are separate products that happen to
// render the same rows through the same component.
//
// This is a REQUIRED argument rather than an inferred one on purpose. Every call site
// has to name its audience, the shaped item exposes one boolean instead of two
// timestamps, and the shared component cannot render the wrong side even if a page
// over-selects both columns -- the only way to cross the wires is to pass the wrong
// literal here, which is one reviewable token in a diff rather than a silent leak
// through a field that happened to be selected.
export type ReadSide = "staff" | "client";

// What the client-facing "concept proposal" button needs to decide what to show:
// premium clients get the real read-only proposal (once ready); base clients get
// an upsell teaser. Carried per-item so the swipe card and report row render off
// one field.
export interface ConceptReveal {
  tier: "premium" | "base";
  status: ConceptProposalStatus | null; // premium only; null = no proposal yet
  proposal: ConceptProposal | null; // premium + ready only
}

// Stamp concept-reveal state onto already-shaped items. Base tier carries no
// proposal data (it's a Premium deliverable) -- the teaser is pure UI. Premium
// looks each card up in the batch map; absent = no proposal yet.
export function withConcept(
  items: ReportItem[],
  tier: "premium" | "base",
  byCard: Map<string, { status: ConceptProposalStatus; proposal: ConceptProposal | null }>,
): ReportItem[] {
  return items.map((it) => {
    if (tier === "base") return { ...it, concept: { tier: "base", status: null, proposal: null } };
    const c = byCard.get(it.id);
    return { ...it, concept: { tier: "premium", status: c?.status ?? null, proposal: c?.proposal ?? null } };
  });
}

// The columns the list needs off each joined review_card. A fuller select is
// structurally assignable, so callers can over-select freely — the swipe query
// adds the description/eligibility/funding columns that populate the rich fields.
export type ReportCardRow = Pick<
  ReviewCard,
  "id" | "grant_id" | "fit_score" | "proposed_role" | "decision" | "factor_scores"
> & {
  concept_synopsis?: string | null;
  sme_released_at?: string | null;
  pursuit_path?: PursuitPath | null;
  // The QA override layer (migration 0088). All optional: a list that does not select them resolves to
  // "no override" (the engine score/factors, no badge) via resolveFit — byte-identical to pre-0088.
  qa_fit_score?: number | null;
  qa_factor_scores?: FactorScores | null;
  qa_sources?: string[] | null;
  qa_status?: string | null;
  qa_engine_fit_score?: number | null;
  // Both optional: a surface selects only its own side's column, and a row that never
  // selected either shapes to read: false -- an unread row, which is the honest
  // default for a list that has no read state to show.
  staff_read_at?: string | null;
  client_read_at?: string | null;
  grants:
    | (Pick<
        Grant,
        "title" | "funder" | "submission_deadline" | "award_range_min" | "award_range_max" | "award_range_is_estimate" | "focus_areas"
      > &
        Partial<Pick<Grant, "total_funding" | "cost_share" | "geographic_eligibility" | "eligible_entity_types" | "description" | "fon" | "source_url">>)
    | null;
};

// HTML → a plain, whitespace-collapsed, sentence-clean preview capped at `max`.
function toPlain(html: string | null | undefined, max = 240): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

export function toReportItem(card: ReportCardRow, side: ReadSide): ReportItem {
  const g = card.grants;
  const days = deadlineDaysLeft(g?.submission_deadline);
  // Coalesce the engine score/factors against the QA override layer (staleness-guarded). With no qa_*
  // selected / no verdict this returns the engine values and qa:null — today's display.
  const resolved = resolveFit(card);
  const fit = resolved.fitScore;
  return {
    id: card.id,
    grantId: card.grant_id,
    title: g?.title || "Untitled opportunity",
    funder: g?.funder ?? null,
    fitScore: fit,
    band: fit === null ? null : FIT_BAND[fit],
    role: card.proposed_role,
    focusAreas: (g?.focus_areas ?? []).slice(0, 2),
    awardRange: formatAwardRange(g?.award_range_min, g?.award_range_max),
    awardIsEstimate: !!g?.award_range_is_estimate,
    deadlineLabel: formatDeadlineShort(g?.submission_deadline),
    deadlineDaysLeft: days,
    deadlineSoon: days !== null && days >= 0 && days <= 30,
    decision: card.decision,
    rowFactors: factorViews(resolved.factorScores, ROW_FACTORS),
    totalAvailable: g?.total_funding ?? null,
    matchRequired: compactCostShare(g?.cost_share),
    purpose: toPlain(g?.description, 240),
    eligibleTypes: (g?.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " ")).slice(0, 4),
    geography: g?.geographic_eligibility ?? null,
    programIdea: toPlain(card.concept_synopsis, 220),
    category: (g?.focus_areas ?? [])[0] ?? null,
    nofoNumber: g?.fon ?? null,
    // "manual-paste" is the ingest sentinel for a grant with no real source URL (see
    // app/api/grants/ingest). Every other source_url consumer filters it; do the same here so
    // a "Read full NOFO" link never points at the literal string (it falls back to the detail
    // page instead).
    sourceUrl: g?.source_url && g.source_url !== "manual-paste" ? g.source_url : null,
    smeReleased: !!card.sme_released_at,
    pursuitPath: card.pursuit_path ?? null,
    read: !!(side === "staff" ? card.staff_read_at : card.client_read_at),
    qa: resolved.qa,
  };
}

// Rank: strongest fit first, then soonest real deadline (rolling/TBD sink to the
// bottom), then title for a stable order.
export function toReportItems(cards: ReportCardRow[], side: ReadSide): ReportItem[] {
  return cards.map((c) => toReportItem(c, side)).sort((a, b) => {
    // Unscored sinks below every scored card. It is not a zero — it is an absence,
    // and ranking it first or last by accident is how it gets read as one.
    const af = a.fitScore ?? -1;
    const bf = b.fitScore ?? -1;
    if (bf !== af) return bf - af;
    const ad = a.deadlineDaysLeft, bd = b.deadlineDaysLeft;
    if (ad !== bd) {
      if (ad === null) return 1;
      if (bd === null) return -1;
      return ad - bd;
    }
    return a.title.localeCompare(b.title);
  });
}

// The staff review-queue lifecycle bucket for a card (0059+). `hasReleaseGate` is
// true for account-managed clients and un-converted leads -- staff hold the card
// before the client/prospect ever sees it, so an undecided, un-released card is
// "admin" (still ours to review/release). Standard clients have no release gate:
// their queue is the client's the moment it's scored, so undecided cards read as
// "client". A released card leaves "admin" for "client" the instant it's sent out.
export type StaffBucket = "admin" | "client" | "pursued" | "rejected";
export function staffBucket(item: ReportItem, hasReleaseGate: boolean): StaffBucket {
  if (item.decision === "passed") return "rejected";
  if (item.decision === "approved") return "pursued";
  if (!hasReleaseGate) return "client";
  return item.smeReleased ? "client" : "admin";
}

// Attribution label for a recorded decision: "you" when the viewer made it, the
// client org name when the client side did, else "your GRANTED team". Null when
// undecided. Pure — the page supplies viewerId + clientName.
export function deciderLabel(
  decision: CardDecision,
  decidedBy: string | null,
  decidedByActor: string | null,
  viewerId: string | null,
  clientName: string,
): string | null {
  if (decision === "pending" || !decidedBy) return null;
  if (viewerId && decidedBy === viewerId) return "you";
  if (decidedByActor === "client") return clientName;
  return "your GRANTED team";
}

export interface ReportStats {
  matched: number;
  // Mean over the SCORED items only. Null when nothing is scored — an average that
  // silently counted unscored cards as 1 was reporting a worse book than exists.
  avgFit: string | null;
  // How many carry no score at all, so a surface can say so instead of implying the
  // average covers everything.
  unscored: number;
  dueSoon: number; // deadline within 30 days
}

export function reportStats(items: ReportItem[]): ReportStats {
  const scored = items.filter((i): i is ReportItem & { fitScore: 1 | 2 | 3 } => i.fitScore !== null);
  const avg = scored.length ? scored.reduce((s, i) => s + i.fitScore, 0) / scored.length : null;
  return {
    matched: items.length,
    avgFit: avg === null ? null : avg.toFixed(1),
    unscored: items.length - scored.length,
    dueSoon: items.filter((i) => i.deadlineSoon).length,
  };
}
