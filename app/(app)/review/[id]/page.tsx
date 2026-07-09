import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DecisionBadge } from "@/components/grants/badges";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { SectionLabel, KeyCallout, Collapsible, GrantBody, GrantStatTiles, GrantStatusPill, WhoCanApply, type GrantDetailFields } from "@/components/grants/grant-detail";
import { DecisionPanel } from "./decision-panel";
import { AlertSend } from "./alert-send";
import { ProspectContact } from "./prospect-contact";
import { RecommendedPrime } from "./recommended-prime";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";
import type { ReviewCard, Client, Grant, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "primary_contact_name"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url" | "primary_contact_email" | "primary_contact_name"> | null;
  grants: (GrantDetailFields & Pick<Grant, "title" | "funder" | "fon">) | null;
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
    .select("*, clients(id, name, org_type, engagement_tier, primary_contact_email, primary_contact_name), prospects(id, name, org_type, source_url, primary_contact_email, primary_contact_name), grants(id, title, funder, fon, grant_status, source_url, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile)")
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

  // Additive read for the Match Score card: how many client cards this grant
  // produced (real, grant-level context -- NOT an invented sub-score).
  let clientMatchCount: number | null = null;
  if (card.grant_id) {
    const { count } = await supabase
      .from("review_cards")
      .select("id", { count: "exact", head: true })
      .eq("grant_id", card.grant_id)
      .eq("card_type", "client");
    clientMatchCount = count ?? null;
  }

  return (
    <div className="min-h-full bg-brand-cream px-6 py-7 sm:px-8">
      {/* Navy hero: full-pane width, grant identity + the four defining facts as tiles. */}
      <NavyHero
        eyebrow="Grant Match Review"
        eyebrowRight={<GrantStatusPill status={g?.grant_status} />}
        title={g?.title || "Opportunity"}
        subtitle={[g?.funder, g?.fon].filter(Boolean).join(" · ") || "—"}
        actions={card.decision !== "pending" ? <DecisionBadge decision={card.decision} /> : undefined}
      >
        {g && <GrantStatTiles grant={g} tone="onHero" />}
      </NavyHero>

      {/* Two-column body below the hero: floating main cards + sticky decision rail. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        <main className="min-w-0 space-y-6">
          {tab === "grant" ? (
            g ? (
              <>
                {/* Match Score leads the main column on the Grant tab. */}
                <MatchScoreCard
                  fitScore={card.fit_score}
                  derivation={card.reasoning_context?.fit_score_derivation}
                  deadline={g?.submission_deadline}
                  clientMatchCount={clientMatchCount}
                />
                <GrantBody grant={g} showStats={false} showWhoCanApply={false} />
              </>
            ) : null
          ) : (
            <MatchTab card={card} orgName={orgName} isProspect={isProspect} />
          )}
        </main>

        <aside className="space-y-4">
          <div className="sticky top-6 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <StepLink id={card.id} tab="grant" n={1} title="The Grant" active={tab === "grant"} />
              <StepLink id={card.id} tab="match" n={2} title="The Match" active={tab === "match"} />
            </div>
            {/* ProspectContact edits the send recipient -> sits directly above the decision panel. */}
            {isAdmin && isProspect && card.prospects && (
              <ProspectContact
                prospectId={card.prospects.id}
                initialEmail={card.prospects.primary_contact_email}
                initialName={card.prospects.primary_contact_name}
              />
            )}
            <DecisionPanel
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
          {/* Who Can Apply (chips) suits the narrow rail; Grant tab only. */}
          {tab === "grant" && g && <WhoCanApply grant={g} dense />}
        </aside>
      </div>
    </div>
  );
}

/* ── Tab 2: The Match (client-match analysis) ─────────────────────────────── */
function MatchTab({ card, orgName, isProspect }: { card: FullCard; orgName: string; isProspect: boolean }) {
  void orgName;
  const rc = card.reasoning_context || {};
  const watchouts = cleanWatchouts(card.before_you_approve);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat tone="onLight" accent label="Fit" value={`${card.fit_score} · ${BAND[card.fit_score] ?? "—"}`} />
        <Stat tone="onLight" label="Proposed role" value={card.proposed_role || "—"} />
        <RecommendedPrime
          prime={card.recommended_prime}
          proposedRole={card.proposed_role}
          roleAssignmentLogic={card.reasoning_context?.role_assignment_logic}
          consortiumRationale={card.reasoning_context?.consortium_rationale}
        />
      </div>

      {(card.description_short || (card.why_this_org?.length || 0) > 0) && (
        <Card className="p-6 sm:p-7">
          <SectionLabel>Match Rationale</SectionLabel>
          {card.description_short && (
            <div className="mt-3">
              <KeyCallout>{card.description_short}</KeyCallout>
            </div>
          )}
          {(card.why_this_org?.length || 0) > 0 && (
            <ul className="mt-4 space-y-2.5">
              {card.why_this_org!.map((w, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy" strokeWidth={3} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {card.concept_synopsis && (
        <Card className="p-6 sm:p-7">
          <SectionLabel>Concept Proposal</SectionLabel>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{card.concept_synopsis}</p>
        </Card>
      )}

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

      {rc.fit_score_derivation && (
        <Collapsible label="How this score was reached">
          <p className="pt-1 text-sm leading-relaxed text-foreground">{rc.fit_score_derivation}</p>
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

// Real days-to-deadline chip text, derived from submission_deadline (no invention).
function daysToDeadline(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime()) || !/\d{4}/.test(s)) return null;
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "Deadline passed";
  if (days === 0) return "Due today";
  return `${days} day${days === 1 ? "" : "s"} to deadline`;
}

// Match Score card — REAL data only (issue #94 option b; full sub-scores tracked
// in #105). The fit band + "n of 3" carry meaning; the meter color is redundant,
// never load-bearing. Supporting text is the engine's real fit_score_derivation.
function MatchScoreCard({
  fitScore,
  derivation,
  deadline,
  clientMatchCount,
}: {
  fitScore: number;
  derivation?: string;
  deadline: string | null | undefined;
  clientMatchCount: number | null;
}) {
  const band = BAND[fitScore] ?? "—";
  const bandText = fitScore >= 3 ? "text-emerald-700" : fitScore === 2 ? "text-brand-orange" : "text-muted-foreground";
  const seg = (n: number) =>
    n <= fitScore
      ? fitScore >= 3
        ? "bg-emerald-500"
        : fitScore === 2
          ? "bg-brand-orange"
          : "bg-muted-foreground"
      : "bg-brand-navy/10";
  const dl = daysToDeadline(deadline);
  return (
    <div className="rounded-2xl bg-white p-5 shadow-soft">
      <div className="flex items-center justify-between">
        <SectionLabel>Match score</SectionLabel>
        <span className={`rounded-full bg-brand-navy/[0.06] px-2.5 py-0.5 text-[11px] font-semibold ${bandText}`}>{band}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-serif text-3xl font-semibold text-brand-navy">{fitScore}</span>
        <span className="text-sm text-muted-foreground">of 3 · {band}</span>
      </div>
      <div className="mt-3 flex gap-1.5" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full ${seg(n)}`} />
        ))}
      </div>
      {derivation && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{derivation}</p>}
      {(dl || (clientMatchCount != null && clientMatchCount > 0)) && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {dl && <span className="inline-flex items-center rounded-full bg-brand-cream px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">{dl}</span>}
          {clientMatchCount != null && clientMatchCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-brand-cream px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
              {clientMatchCount} client match{clientMatchCount === 1 ? "" : "es"} for this grant
            </span>
          )}
        </div>
      )}
    </div>
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
