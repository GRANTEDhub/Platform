import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DecisionBadge } from "@/components/grants/badges";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { SectionLabel, Collapsible, GrantBody, GrantStatTiles, GrantStatusPill, WhoCanApply, type GrantDetailFields } from "@/components/grants/grant-detail";
import { DecisionPanel } from "./decision-panel";
import { AlertSend } from "./alert-send";
import { ProspectContact } from "./prospect-contact";
import { RecommendedPrime } from "./recommended-prime";
import { ExpandableText } from "./expandable-text";
import { ProgramAwardMap } from "./program-award-map";
import { formatDeadlineShort } from "@/lib/grants/format";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";
import type { ProgramAwardSummary } from "@/lib/grants/program-awards";
import type { ReviewCard, Client, Grant, Prospect, FactorScores, FactorScore, FactorRating } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "primary_contact_name"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url" | "primary_contact_email" | "primary_contact_name"> | null;
  grants: (GrantDetailFields & Pick<Grant, "title" | "funder" | "fon" | "program_award_summary" | "assistance_listings">) | null;
};

type TabKey = "grant" | "match";

const BAND: Record<number, string> = { 3: "Strong fit", 2: "Conditional", 1: "Weak" };

// Match watch-outs: strip "STOP:" prefixes and drop automatable registry lookups
// (SAM.gov / USASpending / RUCC / UEI-CAGE-DUNS) that a later API pass will handle
// -- keep only substantive human-judgment items.
const AUTOMATABLE = /\b(sam\.?gov|usaspending|rucc|uei|cage code|duns)\b/i;
function cleanWatchouts(items: string[] | null | undefined): string[] {
  return (items ?? [])
    .map((s) => s.replace(/^\s*stop\s*[:\-–—]\s*/i, "").trim())
    .filter((s) => s && !AUTOMATABLE.test(s));
}

export default async function CardDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const profile = await requireUser();
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select("*, clients(id, name, org_type, engagement_tier, primary_contact_email, primary_contact_name), prospects(id, name, org_type, source_url, primary_contact_email, primary_contact_name), grants(id, title, funder, fon, grant_status, source_url, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile, program_award_summary, assistance_listings)")
    .eq("id", params.id)
    .single();

  const card = data as FullCard | null;
  if (!card) notFound();

  const g = card.grants;
  const isProspect = card.card_type === "prospect";
  const orgName = card.clients?.name || card.prospects?.name || "Match";
  const isAdmin = profile.role === "admin";
  const tab: TabKey = searchParams.tab === "match" ? "match" : "grant";

  // Sent-state for the alert send button, derived from grant_alerts (no migration).
  const sentAlert = isAdmin ? await getSentAlertForCard(card.id) : null;
  const contactName = card.prospects?.primary_contact_name || card.clients?.primary_contact_name || null;

  // Additive read for the merged Match-summary box: how many client cards this grant
  // produced (real, grant-level context -- NOT an invented sub-score). Shown as a chip.
  let clientMatchCount: number | null = null;
  if (card.grant_id) {
    const { count } = await supabase
      .from("review_cards")
      .select("id", { count: "exact", head: true })
      .eq("grant_id", card.grant_id)
      .eq("card_type", "client");
    clientMatchCount = count ?? null;
  }

  // Score block: real fit_score + "SCORE" label, top-right inside the banner (both
  // tabs). Carries the decided-state badge beneath it when a decision is recorded.
  const scoreBlock = (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-col items-end leading-none">
        <span className="font-serif text-[32px] font-semibold text-white">{card.fit_score}</span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-orange">Score</span>
      </div>
      {card.decision !== "pending" && <DecisionBadge decision={card.decision} />}
    </div>
  );

  // Review actions box (top-right, beside the banner): step toggle + Send/Reject
  // only. Score feedback (Agree/Flag) lives in the rail below, not here.
  const reviewActions = (
    <div className="flex h-full flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <StepLink id={card.id} tab="grant" n={1} title="The Grant" active={tab === "grant"} />
        <StepLink id={card.id} tab="match" n={2} title="The Match" active={tab === "match"} />
      </div>
      <DecisionPanel
        variant="decision"
        className="flex-1"
        cardId={card.id}
        decision={card.decision}
        isAdmin={isAdmin}
        alertSend={
          isAdmin ? (
            <AlertSend
              cardId={card.id}
              sentAt={sentAlert?.sentAt ?? null}
              sentTo={sentAlert?.sentTo ?? null}
              contactName={contactName}
            />
          ) : null
        }
      />
    </div>
  );

  return (
    <div className="min-h-full bg-brand-cream px-6 py-7 sm:px-8">
      {/* Top strip: narrowed navy banner (left) + review-actions box (right).
          items-stretch so the right box matches the banner height -> one clean row.
          The banner FORMAT is identical on both tabs; only the body below differs. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-stretch">
        <NavyHero
          eyebrow="Grant Match Review"
          eyebrowRight={<GrantStatusPill status={g?.grant_status} />}
          title={g?.title || "Opportunity"}
          subtitle={[g?.funder, g?.fon].filter(Boolean).join(" · ") || "—"}
          actions={scoreBlock}
        >
          {g && (tab === "match"
            ? <MatchStatTiles card={card} grant={g} />
            : <GrantStatTiles grant={g} tone="onHero" />)}
        </NavyHero>
        {reviewActions}
      </div>

      {/* Body below the strip: main content + rail. Same column template so the rail
          lines up under the review-actions box. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        <main className="min-w-0 space-y-6">
          {/* The Grant tab describes the grant, not the match -- What It Funds leads
              here. Match Score lives on the Match tab (wired in a later part). */}
          {tab === "grant" ? (
            g ? (
              <>
                <GrantBody grant={g} showStats={false} showWhoCanApply={false} />
                <ProgramAwardMap
                  grantId={card.grant_id ?? ""}
                  initialSummary={(g.program_award_summary as unknown as ProgramAwardSummary | null) ?? null}
                  hasCfda={Array.isArray(g.assistance_listings) && g.assistance_listings.length > 0}
                />
              </>
            ) : null
          ) : (
            <MatchTab card={card} orgName={orgName} isProspect={isProspect} clientMatchCount={clientMatchCount} />
          )}
        </main>

        <aside className="space-y-4">
          {/* Rail beside the main column: its first card top-aligns with the main
              column's first card (no sticky wrapper -> no stray leading margin).
              ProspectContact edits the send recipient (prospect cards only). */}
          {isAdmin && isProspect && card.prospects && (
            <ProspectContact
              prospectId={card.prospects.id}
              initialEmail={card.prospects.primary_contact_email}
              initialName={card.prospects.primary_contact_name}
            />
          )}
          {/* Grant tab: Who Can Apply beside What It Funds. Match tab: the Agree/Flag
              score-feedback box in its own card beside the merged Match Score box. */}
          {tab === "grant" && g && <WhoCanApply grant={g} dense />}
          {tab === "match" && (
            <DecisionPanel variant="feedback" cardId={card.id} decision={card.decision} isAdmin={isAdmin} />
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── Tab 2: The Match (client-match analysis) ─────────────────────────────── */
function MatchTab({
  card,
  orgName,
  isProspect,
  clientMatchCount,
}: {
  card: FullCard;
  orgName: string;
  isProspect: boolean;
  clientMatchCount: number | null;
}) {
  void orgName;
  const watchouts = cleanWatchouts(card.before_you_approve);
  return (
    <div className="space-y-6">
      {/* Merged summary: score + rationale + score reasoning + Agree/Flag, one box.
          Fit / Proposed role / Recommended prime now live in the banner tiles. */}
      <MatchSummaryCard card={card} clientMatchCount={clientMatchCount} />

      <ConceptProposalCard card={card} />

      {watchouts.length > 0 && (
        <Collapsible label="Watch-outs">
          <div className="space-y-2.5 pt-1">
            {watchouts.map((w, i) => (
              <div key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-orange" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {isProspect && card.prospects?.source_url && (
        <p className="text-sm">
          <a href={card.prospects.source_url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-orange hover:underline">Prospect source ↗</a>
        </p>
      )}
    </div>
  );
}

// Match-tab banner tiles: the four cards show MATCH facts (Fit / Proposed role /
// Recommended prime / Deadline) instead of grant facts, switched by tab in the
// banner. Same onHero styling; the free-text values (role, prime) truncate to one
// line -- the full role reads in the merged box below, the full prime in the
// click-to-expand overlay. Fit uses "N · Band" (fits 16px); "of 3" is implied by
// the SCORE block top-right.
function MatchStatTiles({ card, grant }: { card: FullCard; grant: GrantDetailFields }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat tone="onHero" truncateValue label="Fit" value={`${card.fit_score} · ${BAND[card.fit_score] ?? "—"}`} />
      <Stat tone="onHero" truncateValue label="Proposed role" value={card.proposed_role || "—"} />
      <RecommendedPrime
        tone="onHero"
        prime={card.recommended_prime}
        proposedRole={card.proposed_role}
        roleAssignmentLogic={card.reasoning_context?.role_assignment_logic}
        consortiumRationale={card.reasoning_context?.consortium_rationale}
      />
      <Stat tone="onHero" accent truncateValue label="Deadline" value={formatDeadlineShort(grant.submission_deadline)} />
    </div>
  );
}

// Per-factor breakdown (#105): the 6 STRENGTH factors the scorer surfaces, each an
// ordinal rating + one-line rationale. Ordinals only -- no percentages/gauges.
// "Insufficient data" rows are muted: they double as a signal of what client data
// to go collect. Null factor_scores (cards scored before #105) render a "not yet
// scored" line rather than breaking.
const FACTOR_LABELS: { key: keyof FactorScores; label: string }[] = [
  { key: "seat_role", label: "Seat / role fit" },
  { key: "eligibility", label: "Eligibility" },
  { key: "geographic", label: "Geographic fit" },
  { key: "program_history", label: "Program history" },
  { key: "cost_share", label: "Match / cost-share" },
  { key: "mission", label: "Mission alignment" },
];

// Segment count per rating: fill carries the meaning, NOT hue (the user is
// colorblind). Strong=3, Moderate=2, Weak=1; "insufficient data" is a dashed
// hollow track -- deliberately NOT a 1-segment bar, so it never reads as "Weak".
const FACTOR_SEGMENTS: Record<Exclude<FactorRating, "insufficient_data">, number> = {
  strong: 3,
  moderate: 2,
  weak: 1,
};
const FACTOR_WORD: Record<FactorRating, string> = {
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  insufficient_data: "insufficient data",
};

// One factor row: name + word label + 3-segment bar (or a dashed hollow track for
// insufficient data). The engine's one-line rationale rides in a desktop-only CSS
// group-hover tooltip -- no client JS, so this stays a server component.
function FactorRow({ label, score }: { label: string; score: FactorScore }) {
  const insufficient = score.rating === "insufficient_data";
  const filled = score.rating === "insufficient_data" ? 0 : FACTOR_SEGMENTS[score.rating];
  return (
    <li
      className={`group relative flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-brand-cream/70 ${
        insufficient ? "opacity-60" : ""
      }`}
    >
      <span className="text-sm font-medium text-brand-navy">{label}</span>
      <div className="flex items-center gap-3">
        <span
          className={`min-w-[92px] text-right text-[11px] text-muted-foreground ${insufficient ? "italic" : ""}`}
        >
          {FACTOR_WORD[score.rating]}
        </span>
        {insufficient ? (
          <span className="h-2.5 w-[126px] rounded-full border border-dashed border-brand-navy/30" aria-hidden />
        ) : (
          <span className="flex gap-1.5" aria-hidden>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`h-2.5 w-[38px] rounded-full ${n <= filled ? "bg-brand-navy" : "bg-brand-navy/[0.12]"}`}
              />
            ))}
          </span>
        )}
      </div>
      {score.rationale && (
        <div className="pointer-events-none absolute bottom-full right-0 z-10 mb-1.5 hidden max-w-[262px] rounded-lg bg-brand-navy px-3 py-2 text-xs leading-relaxed text-white shadow-lg group-hover:block">
          {score.rationale}
          <span className="absolute right-6 top-full h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-brand-navy" />
        </div>
      )}
    </li>
  );
}

function FactorBreakdown({ scores }: { scores: FactorScores | null }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">Factor breakdown</p>
      {!scores ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Not yet scored for factors — re-match this grant to generate the per-factor breakdown.
        </p>
      ) : (
        <>
          <ul className="mt-2 space-y-0.5">
            {FACTOR_LABELS.map(({ key, label }) => {
              const f = scores[key];
              if (!f) return null;
              return <FactorRow key={key} label={label} score={f} />;
            })}
          </ul>
          <p className="mt-3 px-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Bar fill = rating (3 / 2 / 1 segments). Dashed = no data yet — distinct from a one-segment “Weak.” Hover a row for the rationale.
          </p>
        </>
      )}
    </div>
  );
}

// Honest "N of 3" radial ring -- NOT a 0-100 gauge. The arc fills fit_score/3 of the
// circle (2 -> a two-thirds arc). Driven by fit_score, which is ALWAYS present, so
// the ring renders even when factor_scores is null. Uniform brand-orange arc on a
// faint navy track; the center is the literal ordinal, never an invented percentage.
function ScoreRing({ fitScore }: { fitScore: number }) {
  const size = 168;
  const stroke = 13;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, (Number.isFinite(fitScore) ? fitScore : 0) / 3));
  const filled = circ * frac;
  return (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-brand-navy/10"
        />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circ - filled}`}
            className="stroke-brand-orange"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-5xl font-semibold leading-none text-brand-navy">{fitScore}</span>
        <span className="mt-1.5 text-xs font-medium text-muted-foreground">of 3</span>
      </div>
    </div>
  );
}

// The merged Match-summary box (Match tab, first card): an honest N-of-3 ring on the
// left, the #105 per-factor breakdown as a segment-bar column on the right, then the
// why-this-org checkmarks + "How this score was reached" show-more below. REAL data
// only -- ordinals, no invented precision.
function MatchSummaryCard({
  card,
  clientMatchCount,
}: {
  card: FullCard;
  clientMatchCount: number | null;
}) {
  const rc = card.reasoning_context || {};
  const fitScore = card.fit_score;
  const band = BAND[fitScore] ?? "—";
  const bandText = fitScore >= 3 ? "text-emerald-700" : fitScore === 2 ? "text-brand-orange" : "text-muted-foreground";
  // Full reasoning behind the show-more: the eligibility read + the engine's score
  // derivation -- both real reasoning_context fields, nothing invented.
  const reasoning = [rc.eligibility_analysis, rc.fit_score_derivation].filter(Boolean).join("\n\n");
  // Manual-override badge (migration 0040): set when a human forced this card past
  // a block. "hard: …" = forced past an eligibility warning; "soft: …" = past the
  // engine's suppression. The full reason also rides in before_you_approve.
  const override = card.override_reason;
  const overrideHard = override?.startsWith("hard:");
  return (
    <Card className="p-6 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Match score</SectionLabel>
        {override && (
          <span
            title={override}
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              overrideHard ? "bg-brand-orange/15 text-brand-orange" : "bg-brand-navy/[0.06] text-muted-foreground"
            }`}
          >
            Manual override
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-7">
        {/* Left: honest N-of-3 ring + band pill */}
        <div className="flex flex-none flex-col items-center gap-3.5 sm:w-[188px]">
          <ScoreRing fitScore={fitScore} />
          <span className={`rounded-full bg-brand-navy/[0.06] px-4 py-1.5 text-xs font-semibold ${bandText}`}>{band}</span>
        </div>

        {/* Hairline divider */}
        <div className="hidden w-px self-stretch bg-brand-navy/[0.08] sm:block" />

        {/* Right: per-factor breakdown */}
        <div className="min-w-0 w-full flex-1">
          <FactorBreakdown scores={card.factor_scores} />
        </div>
      </div>

      {(card.why_this_org?.length || 0) > 0 && (
        <ul className="mt-6 space-y-2.5 border-t border-brand-navy/[0.08] pt-5">
          {card.why_this_org!.map((w, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy" strokeWidth={3} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {reasoning && (
        <div className="mt-4 border-t border-brand-navy/[0.08] pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">How this score was reached</p>
          <ExpandableText text={reasoning} className="mt-2 text-sm leading-relaxed text-foreground" />
        </div>
      )}

      {clientMatchCount != null && clientMatchCount > 0 && (
        <div className="mt-4">
          <span className="inline-flex items-center rounded-full bg-brand-cream px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
            {clientMatchCount} client match{clientMatchCount === 1 ? "" : "es"} for this grant
          </span>
        </div>
      )}
    </Card>
  );
}

// Concept Proposal card (Match tab, below the merged summary; Watch-outs sits below
// it). Assembled from REAL engine fields, omitting any that are empty -- never
// invented:
//   structure line: client name + proposed_role, plus the recommended-prime
//     relationship when the client isn't the prime (recommended_prime is set);
//   scope: concept_synopsis (the engine's purpose-built 2-3 sentence SOW);
//   show-more: consortium_rationale (team composition / other required players /
//     gaps) -- prose, since the engine has no structured players list.
// role_assignment_logic is intentionally NOT repeated here; it lives in the prime
// click-to-expand overlay from 3a.
function ConceptProposalCard({ card }: { card: FullCard }) {
  const clientName = (card.clients?.name || card.prospects?.name || "").trim();
  const role = (card.proposed_role ?? "").trim();
  const prime = (card.recommended_prime ?? "").trim();
  const scope = (card.concept_synopsis ?? "").trim();
  const team = (card.reasoning_context?.consortium_rationale ?? "").trim();

  // Nothing real to assemble -> render nothing (never a placeholder).
  if (!scope && !team && !role && !prime) return null;

  return (
    <Card className="p-6 sm:p-7">
      <SectionLabel>Concept Proposal</SectionLabel>

      {(clientName || role) && (
        <p className="mt-3 text-sm text-foreground">
          {clientName && <span className="font-semibold text-brand-navy">{clientName}</span>}
          {clientName && role ? " — " : ""}
          {role}
        </p>
      )}
      {prime && (
        <p className="mt-1 text-sm text-muted-foreground">
          under <span className="font-medium text-brand-navy">{prime}</span> as the prime applicant
        </p>
      )}

      {scope && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{scope}</p>
      )}

      {team && (
        <div className="mt-4 border-t border-brand-navy/[0.08] pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">Team &amp; structure</p>
          <ExpandableText text={team} className="mt-2 text-sm leading-relaxed text-foreground" />
        </div>
      )}
    </Card>
  );
}

// Ordinal tab link (sidebar toggle). Active = filled navy with an orange badge.
function StepLink({ id, tab, n, title, active }: { id: string; tab: TabKey; n: number; title: string; active: boolean }) {
  return (
    <Link
      href={`/review/${id}?tab=${tab}`}
      className={`flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 transition ${
        active ? "bg-brand-navy shadow-soft" : "bg-white shadow-softer hover:shadow-soft"
      }`}
    >
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold ${
        active ? "bg-brand-orange text-white" : "bg-brand-navy/[0.06] text-brand-navy"
      }`}>{n}</span>
      <span className="min-w-0 leading-tight">
        <span className={`block text-[10px] uppercase tracking-[0.1em] ${active ? "text-white/60" : "text-muted-foreground"}`}>Step {n}</span>
        <span className={`block truncate font-serif text-[15px] font-semibold ${active ? "text-white" : "text-brand-navy"}`}>{title}</span>
      </span>
    </Link>
  );
}
