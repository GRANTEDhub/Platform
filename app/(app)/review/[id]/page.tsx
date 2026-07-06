import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DecisionBadge } from "@/components/grants/badges";
import { interTight, sourceSerif } from "@/lib/fonts";
import { StatBand, SectionLabel, KeyCallout, Collapsible, GrantBody, type GrantDetailFields } from "@/components/grants/grant-detail";
import { DecisionPanel } from "./decision-panel";
import type { ReviewCard, Client, Grant, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "primary_contact_name"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url"> | null;
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
    .select("*, clients(id, name, org_type, engagement_tier, primary_contact_email, primary_contact_name), prospects(id, name, org_type, source_url), grants(id, title, funder, fon, source_url, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile)")
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
      {/* Full-width banner: grant identity (toggle lives in the sidebar). */}
      <div className="flex items-start justify-between gap-6 border-b border-brand-navy/10 bg-white px-6 py-5 sm:px-8">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-orange">Grant Match Review</p>
          <h1 className="mt-1 font-serif text-[26px] font-semibold leading-[1.12] tracking-tight text-brand-navy">
            {g?.title || "Opportunity"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {[g?.funder, g?.fon].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        {card.decision !== "pending" && (
          <div className="shrink-0">
            <DecisionBadge decision={card.decision} />
          </div>
        )}
      </div>

      {/* Two-column body: wide main + right sidebar (toggle + decision panel). */}
      <div className="grid grid-cols-1 gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-stretch">
        <main className="rounded-2xl border border-brand-navy/10 bg-white p-6 sm:p-8">
          {tab === "grant" ? (g ? <GrantBody grant={g} /> : null) : <MatchTab card={card} orgName={orgName} isProspect={isProspect} />}
        </main>

        <aside>
          <div className="sticky top-6 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <StepLink id={card.id} tab="grant" n={1} title="The Grant" active={tab === "grant"} />
              <StepLink id={card.id} tab="match" n={2} title="The Match" active={tab === "match"} />
            </div>
            <DecisionPanel
              cardId={card.id}
              decision={card.decision}
              isAdmin={isAdmin}
              draft={card.draft_outreach_email ?? ""}
              finalEmail={card.final_outreach_email}
              recipientEmail={card.clients?.primary_contact_email ?? null}
              defaultSubject={defaultSubject}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ── Tab 2: The Match (client-match analysis) ─────────────────────────────── */
function MatchTab({ card, orgName, isProspect }: { card: FullCard; orgName: string; isProspect: boolean }) {
  const rc = card.reasoning_context || {};
  const watchouts = cleanWatchouts(card.before_you_approve);
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
        <p className="mt-8 text-sm">
          <a href={card.prospects.source_url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-orange hover:underline">Prospect source ↗</a>
        </p>
      )}
    </div>
  );
}

// Ordinal tab link (sidebar toggle). Active = filled navy with an orange badge.
function StepLink({ id, tab, n, title, active }: { id: string; tab: TabKey; n: number; title: string; active: boolean }) {
  return (
    <Link
      href={`/review/${id}?tab=${tab}`}
      className={`flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition ${
        active ? "border-brand-navy bg-brand-navy" : "border-brand-navy/10 bg-white hover:border-brand-navy/25"
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
