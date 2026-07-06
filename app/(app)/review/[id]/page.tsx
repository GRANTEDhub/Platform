import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronDown, Check } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DecisionBadge } from "@/components/grants/badges";
import { interTight, sourceSerif } from "@/lib/fonts";
import { DecisionPanel } from "./decision-panel";
import type { ReviewCard, Client, Grant, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "primary_contact_name"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url"> | null;
  grants: Pick<
    Grant,
    | "id" | "title" | "funder" | "fon" | "source_url"
    | "submission_deadline" | "period_of_performance"
    | "cost_share" | "award_range_min" | "award_range_max" | "award_range_is_estimate"
    | "num_awards" | "description"
    | "eligible_entity_types" | "geographic_eligibility" | "ineligible_entities" | "subaward_prohibited"
    | "incumbent_risk" | "technical_burden_flags" | "hard_disqualifiers" | "verification_flags"
    | "scoring_rubric"
  > | null;
};

type TabKey = "grant" | "match";

const BAND: Record<number, string> = { 3: "Strong fit", 2: "Conditional", 1: "Weak" };

function abbrevAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return s;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  if (unit === "k") n *= 1e3;
  else if (unit === "m") n *= 1e6;
  else if (unit === "b") n *= 1e9;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function formatAwardRange(min: string | null | undefined, max: string | null | undefined): string {
  const lo = abbrevAmount(min);
  const hi = abbrevAmount(max);
  if (!lo && !hi) return "—";
  if (lo && hi) return `${lo} – ${hi}`;
  return (lo || hi)!;
}

function compactCostShare(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  if (/^(none|no\b|not required|n\/?a|\$?0\b|0%)/i.test(s)) return "None";
  return s;
}

// "March 15, 2026" when it parses as a real date; verbatim otherwise ("Rolling").
function formatDeadline(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return format(d, "MMMM d, yyyy");
  return s;
}

// Substantive risks only: hard disqualifiers + technical-burden flags always;
// from verification_flags drop imperative boilerplate. Capped to stay scannable.
function isBoilerplate(s: string): boolean {
  return /^(verify|re-?verify|confirm|check|double|ensure|review|validate)\b/i.test(s.trim());
}
type Risk = { tone: "hard" | "warn"; text: string };
function collectRisks(g: FullCard["grants"]): Risk[] {
  return [
    ...(g?.hard_disqualifiers ?? []).map((t): Risk => ({ tone: "hard", text: t })),
    ...(g?.technical_burden_flags ?? []).map((t): Risk => ({ tone: "warn", text: t })),
    ...(g?.verification_flags ?? []).filter((t) => !isBoilerplate(t)).map((t): Risk => ({ tone: "warn", text: t })),
  ]
    .filter((r) => r.text?.trim())
    .slice(0, 6);
}

// Scoring rubric as TOP-LEVEL line items + points only. Values are point totals
// (number) or short "40 pts"/"40 points"/"25%" tokens; long descriptive values
// collapse to the criterion name (no nested per-criterion dump).
function rubricRows(rubric: Record<string, number | string> | null | undefined): { name: string; points: string }[] {
  return Object.entries(rubric ?? {})
    .filter(([k]) => k?.trim())
    .map(([name, v]) => {
      let points = "";
      if (typeof v === "number") points = `${v} pts`;
      else {
        const s = String(v).trim();
        const exact = s.match(/^(\d+(?:\.\d+)?)\s*(pts?|points?|%)?$/i);
        if (exact) points = /%/.test(s) ? s : `${exact[1]} pts`;
        else {
          const embedded = s.match(/(\d+)\s*(?:points?|pts?)/i);
          if (embedded) points = `${embedded[1]} pts`;
        }
      }
      return { name, points };
    });
}

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
    .select("*, clients(id, name, org_type, engagement_tier, primary_contact_email, primary_contact_name), prospects(id, name, org_type, source_url), grants(id, title, funder, fon, source_url, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric)")
    .eq("id", params.id)
    .single();

  const card = data as FullCard | null;
  if (!card) notFound();

  const g = card.grants;
  const isProspect = card.card_type === "prospect";
  const orgName = card.clients?.name || card.prospects?.name || "Match";
  const isAdmin = profile.role === "admin";
  const tab: TabKey = searchParams.tab === "match" ? "match" : "grant";
  const defaultSubject = `GRANTED Alert! | ${g?.title || "Grant Opportunity"}`;

  return (
    <div className={`${interTight.variable} ${sourceSerif.variable} min-h-full bg-brand-cream`}>
      {/* Full-width banner: grant identity left, tab toggle far-right. */}
      <div className="flex items-center justify-between gap-7 border-b border-brand-navy/10 bg-white px-6 py-5 sm:px-8">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-orange">Grant Match Review</p>
          <h1 className="mt-1 font-serif text-[26px] font-semibold leading-[1.12] tracking-tight text-brand-navy">
            {g?.title || "Opportunity"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {[g?.funder, g?.fon].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {card.decision !== "pending" && <DecisionBadge decision={card.decision} />}
          <div className="flex gap-2">
            <StepLink id={card.id} tab="grant" n={1} title="The Grant" active={tab === "grant"} />
            <StepLink id={card.id} tab="match" n={2} title="The Match" active={tab === "match"} />
          </div>
        </div>
      </div>

      {/* Two-column body: wide main + right sidebar. */}
      <div className="grid grid-cols-1 gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-stretch">
        <main className="rounded-2xl border border-brand-navy/10 bg-white p-6 sm:p-8">
          {tab === "grant" ? <GrantTab g={g} /> : <MatchTab card={card} orgName={orgName} isProspect={isProspect} />}
        </main>

        <aside className="flex flex-col gap-4">
          <DecisionPanel
            cardId={card.id}
            decision={card.decision}
            isAdmin={isAdmin}
            draft={card.draft_outreach_email ?? ""}
            finalEmail={card.final_outreach_email}
            recipientEmail={card.clients?.primary_contact_email ?? null}
            defaultSubject={defaultSubject}
          />
          {tab === "grant" ? <GrantSidebar g={g} /> : <MatchSidebar card={card} />}
        </aside>
      </div>
    </div>
  );
}

/* ── Tab 1: The Grant (main) ──────────────────────────────────────────────── */
function GrantTab({ g }: { g: FullCard["grants"] }) {
  const eligibleTypes = (g?.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " "));
  const risks = collectRisks(g);
  return (
    <div>
      <StatBand
        items={[
          { label: `Award range${g?.award_range_is_estimate ? " · est." : ""}`, value: formatAwardRange(g?.award_range_min, g?.award_range_max) },
          { label: "Est. awards", value: g?.num_awards || "—" },
          { label: "Match required", value: compactCostShare(g?.cost_share) },
          { label: "Deadline", value: formatDeadline(g?.submission_deadline), urgent: true },
        ]}
      />

      <div className="mt-8 grid gap-8 md:grid-cols-2">
        <section>
          <SectionLabel>What it funds</SectionLabel>
          <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{g?.description || "—"}</p>
        </section>
        <section>
          <SectionLabel>Who can apply</SectionLabel>
          {eligibleTypes.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {eligibleTypes.map((t, i) => <Chip key={i}>{t}</Chip>)}
            </div>
          ) : (
            <p className="mt-2.5 text-sm text-muted-foreground">Eligible entity types not specified.</p>
          )}
          <div className="mt-3 space-y-1.5 text-sm text-foreground">
            {g?.geographic_eligibility && <p><span className="text-muted-foreground">Geography: </span>{g.geographic_eligibility}</p>}
            {g?.ineligible_entities && <p><span className="text-muted-foreground">Ineligible: </span>{g.ineligible_entities}</p>}
            {g?.subaward_prohibited && <p className="font-medium text-brand-orange">Subawards prohibited</p>}
          </div>
        </section>
      </div>

      {g?.incumbent_risk && <KeyCallout label="Make-or-break">{g.incumbent_risk}</KeyCallout>}

      {risks.length > 0 && (
        <Collapsible label="Risk & key factors">
          <div className="space-y-2.5 pt-1">
            {risks.map((r, i) => (
              <div key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${r.tone === "hard" ? "bg-destructive" : "bg-brand-orange"}`} />
                <span>{r.text}</span>
              </div>
            ))}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

/* ── Tab 1: The Grant (sidebar) — Additional information ──────────────────── */
function GrantSidebar({ g }: { g: FullCard["grants"] }) {
  const rubric = rubricRows(g?.scoring_rubric as Record<string, number | string> | null);
  const postingLabel = g?.source_url && /simpler\.grants\.gov/i.test(g.source_url) ? "View on Simpler.gov ↗" : "View posting ↗";
  if (!(g?.period_of_performance || rubric.length > 0 || g?.source_url || g?.id)) return null;
  return (
    <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
      <SectionLabel>Additional information</SectionLabel>
      <div className="mt-3">
        {g?.period_of_performance && (
          <div className="flex justify-between gap-3 border-b border-brand-navy/[0.08] pb-2.5 text-sm">
            <span className="text-muted-foreground">Period of performance</span>
            <span className="text-right text-brand-navy">{g.period_of_performance}</span>
          </div>
        )}
        {rubric.length > 0 && (
          <div className="border-b border-brand-navy/[0.08] py-2.5">
            <p className="text-sm text-muted-foreground">Scoring rubric</p>
            <div className="mt-2 space-y-1">
              {rubric.map((r, i) => (
                <div key={i} className="flex justify-between gap-3 text-sm">
                  <span className="text-brand-navy/85">{r.name}</span>
                  {r.points && <span className="shrink-0 text-brand-navy">{r.points}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2 pt-3 text-sm font-medium">
          {g?.source_url && (
            <a href={g.source_url} target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">{postingLabel}</a>
          )}
          {g?.id && <Link href={`/grants/${g.id}`} className="text-brand-orange hover:underline">Open Shred →</Link>}
        </div>
      </div>
    </div>
  );
}

/* ── Tab 2: The Match (main) ──────────────────────────────────────────────── */
function MatchTab({ card, orgName, isProspect }: { card: FullCard; orgName: string; isProspect: boolean }) {
  return (
    <div>
      <StatBand
        items={[
          { label: "Fit", value: `${card.fit_score} · ${BAND[card.fit_score] ?? "—"}`, urgent: true },
          { label: "Proposed role", value: card.proposed_role || "—" },
          { label: "Recommended prime", value: card.recommended_prime || "—" },
        ]}
      />

      {(card.description_short || (card.why_this_org?.length || 0) > 0) && (
        <section className="mt-8">
          <SectionLabel>Match Rationale</SectionLabel>
          {card.description_short && <KeyCallout tight>{card.description_short}</KeyCallout>}
          {(card.why_this_org?.length || 0) > 0 && (
            <ul className="mt-3.5 space-y-2.5">
              {card.why_this_org!.map((w, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy" strokeWidth={3} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {card.concept_synopsis && (
        <section className="mt-8">
          <SectionLabel>Concept Proposal</SectionLabel>
          <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{card.concept_synopsis}</p>
        </section>
      )}

      {isProspect && card.prospects?.source_url && (
        <p className="mt-8 text-sm">
          <a href={card.prospects.source_url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-orange hover:underline">Prospect source ↗</a>
        </p>
      )}
    </div>
  );
}

/* ── Tab 2: The Match (sidebar) — how scored + watch-outs ─────────────────── */
function MatchSidebar({ card }: { card: FullCard }) {
  const rc = card.reasoning_context || {};
  const watchouts = cleanWatchouts(card.before_you_approve);
  const derivation = rc.fit_score_derivation;
  return (
    <>
      {derivation && (
        <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
          <SectionLabel>How this score was reached</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-foreground">{derivation}</p>
        </div>
      )}
      {watchouts.length > 0 && (
        <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
          <details className="group">
            <summary className="flex cursor-pointer items-center justify-between [&::-webkit-details-marker]:hidden">
              <SectionLabel>Watch-outs</SectionLabel>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 space-y-2.5">
              {watchouts.map((w, i) => (
                <div key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-orange" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </>
  );
}

/* ── Shared primitives ────────────────────────────────────────────────────── */

// Ordinal tab in the banner. Active = filled navy with an orange number badge.
function StepLink({ id, tab, n, title, active }: { id: string; tab: TabKey; n: number; title: string; active: boolean }) {
  return (
    <Link
      href={`/review/${id}?tab=${tab}`}
      className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition ${
        active ? "border-brand-navy bg-brand-navy" : "border-brand-navy/10 bg-white hover:border-brand-navy/25"
      }`}
    >
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold ${
        active ? "bg-brand-orange text-white" : "bg-brand-navy/[0.06] text-brand-navy"
      }`}>{n}</span>
      <span className="leading-tight">
        <span className={`block text-[10px] uppercase tracking-[0.1em] ${active ? "text-white/60" : "text-muted-foreground"}`}>Step {n}</span>
        <span className={`block font-serif text-[15px] font-semibold ${active ? "text-white" : "text-brand-navy"}`}>{title}</span>
      </span>
    </Link>
  );
}

// Signature navy stat-band; most-urgent cell in burnt orange.
function StatBand({ items }: { items: { label: string; value: string; urgent?: boolean }[] }) {
  return (
    <div className="flex overflow-hidden rounded-xl">
      {items.map((it, i) => (
        <div key={i} className={`min-w-0 flex-1 px-4 py-3.5 ${it.urgent ? "bg-brand-orange" : "bg-brand-navy"} ${i > 0 ? "border-l border-white/10" : ""}`}>
          <p className={`text-[10px] uppercase tracking-[0.08em] ${it.urgent ? "text-white/75" : "text-white/55"}`}>{it.label}</p>
          <p className="mt-1 break-words font-serif text-lg font-semibold leading-tight text-white">{it.value}</p>
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{children}</p>;
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-brand-navy/[0.06] px-2.5 py-0.5 text-xs text-brand-navy/85">{children}</span>;
}

// Cream / orange-left-border callout. `tight` drops the top margin when it leads
// a section that already has a label above it.
function KeyCallout({ label, tight, children }: { label?: string; tight?: boolean; children: React.ReactNode }) {
  return (
    <div className={`${tight ? "mt-3" : "mt-6"} rounded-r-lg border-l-[3px] border-brand-orange bg-brand-cream px-4 py-3.5`}>
      {label && <p className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-brand-orange">{label}</p>}
      <p className={`${label ? "mt-1.5 " : ""}font-serif text-[17px] leading-snug text-brand-navy`}>{children}</p>
    </div>
  );
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group mt-8 overflow-hidden rounded-xl border border-brand-navy/10">
      <summary className="flex cursor-pointer items-center justify-between bg-brand-navy/[0.02] px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}
