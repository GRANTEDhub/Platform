import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { DecisionBadge } from "@/components/grants/badges";
import { WhatItFunds, WhoCanApply, type GrantDetailFields } from "@/components/grants/grant-detail";
import { FactorBreakdown } from "./match-score";
import { ScoreRing, SectionTitle, Tag } from "./primitives";
import { DecisionBar } from "./decision-bar";
import { FIT_BAND } from "@/lib/report/shape";
import { formatAwardRange, formatDeadline, compactCostShare } from "@/lib/grants/format";
import type { CardDecision, FactorScores } from "@/types/database";

// Read-only Grant Report detail — the shared decision surface's display half.
// Structured to mirror the client-facing Figma: header (facts + honest fit ring)
// → Purpose & overview → Why this matches you (with the platform's per-factor
// scoring graphic merged in) → Eligibility → Key details. Reuses the same
// WhatItFunds / WhoCanApply blocks and FactorBreakdown chart the staff review
// renders, so grant facts + scoring read identically across surfaces.
//
// Deferred: the decision gate (Pursue / Save / Pass) + score agree-disagree
// feedback (Slice 2 — needs a client-write RLS migration) and "Recommended
// partners" (no partner data source yet).

export interface ReportDetailCard {
  fit_score: 1 | 2 | 3;
  proposed_role: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  factor_scores: FactorScores | null;
  decision: CardDecision;
  decided_by: string | null;
  decided_by_actor: string | null;
}

type DetailGrant = GrantDetailFields & {
  assistance_listings?: { number: string; program_title: string }[] | null;
};

// Grant lifecycle → a plain client-legible word (no invented state).
function statusText(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  if (/^(active|posted|open)/.test(s)) return "Open";
  if (/forecast/.test(s)) return "Forecasted";
  if (/(closed|archiv|expired|inactive)/.test(s)) return "Closed";
  return (status ?? "").trim() || "—";
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-[15px] font-semibold text-brand-navy">{value}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-brand-navy">{value}</p>
    </div>
  );
}

export function ReportDetail({
  cardId,
  card,
  grant,
  title,
  funder,
  focusAreas,
  deciderLabel,
  backHref,
  backLabel = "Back to Grant Report",
  decisionBar,
}: {
  cardId: string;
  card: ReportDetailCard;
  grant: DetailGrant;
  title: string;
  funder: string | null;
  focusAreas: string[];
  deciderLabel: string | null;
  backHref: string;
  backLabel?: string;
  // Override the default Pursue/Save/Pass + score-feedback cluster -- used by the
  // staff SME Gate-2 view (account-managed clients, 0059), where the relevant
  // action is "release to client", not a pursue decision the client should make.
  decisionBar?: React.ReactNode;
}) {
  const band = FIT_BAND[card.fit_score] ?? FIT_BAND[1];
  const why = (card.why_this_org ?? []).filter(Boolean);

  const award = formatAwardRange(grant.award_range_min, grant.award_range_max);
  const match = compactCostShare(grant.cost_share);
  const cfda = (grant.assistance_listings ?? []).map((a) => a.number).filter(Boolean).join(", ");
  const showSource = grant.source_url && grant.source_url !== "manual-paste";

  return (
    <div className="animate-fade-up space-y-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      {/* header — facts + honest fit ring */}
      <div className="rounded-3xl bg-white p-8 shadow-grounded">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="font-serif text-[28px] font-semibold leading-tight tracking-tight text-brand-navy">{title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {funder && <p className="text-[15px] text-muted-foreground">{funder}</p>}
              {card.decision !== "pending" && <DecisionBadge decision={card.decision} />}
            </div>
            {(card.proposed_role || focusAreas.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {card.proposed_role && <Tag>{card.proposed_role}</Tag>}
                {focusAreas.map((f, i) => (
                  <Tag key={i}>{f}</Tag>
                ))}
              </div>
            )}
          </div>
          <div className="shrink-0">
            <ScoreRing fitScore={card.fit_score} band={band} size="lg" />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-brand-navy/[0.06] pt-5 sm:grid-cols-4">
          <HeaderStat label={`Award range${grant.award_range_is_estimate ? " · est." : ""}`} value={award} />
          <HeaderStat label="Deadline" value={formatDeadline(grant.submission_deadline)} />
          <HeaderStat label="Status" value={statusText(grant.grant_status)} />
          <HeaderStat label="Expected awards" value={grant.num_awards || "—"} />
        </div>

        {decisionBar ?? <DecisionBar cardId={cardId} decision={card.decision} deciderLabel={deciderLabel} />}
      </div>

      {/* purpose & overview — the grant description */}
      <WhatItFunds grant={grant} label="Purpose & overview" headingStyle="title" elevation="grounded" />

      {/* why this matches you — narrative + the per-factor scoring graphic */}
      {(why.length > 0 || card.concept_synopsis || card.factor_scores) && (
        <Card elevation="grounded" className="p-6 sm:p-7">
          <SectionTitle>Why this matches you</SectionTitle>
          {why.length > 0 && (
            <ul className="mt-3 space-y-2">
              {why.map((w, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-orange" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
          {card.concept_synopsis && (
            <p className="mt-4 text-sm leading-relaxed text-foreground">{card.concept_synopsis}</p>
          )}
          <div className="mt-5 border-t border-brand-navy/[0.08] pt-5">
            <FactorBreakdown scores={card.factor_scores} heading="Fit factors" />
          </div>
        </Card>
      )}

      {/* eligibility */}
      <WhoCanApply grant={grant} label="Eligibility requirements" headingStyle="title" elevation="grounded" />

      {/* key details & links */}
      {(match !== "None" || grant.period_of_performance || funder || cfda || showSource) && (
        <Card elevation="grounded" className="p-6 sm:p-7">
          <SectionTitle>Key details &amp; links</SectionTitle>
          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Match required" value={match} />
            {grant.period_of_performance && <DetailRow label="Period of performance" value={grant.period_of_performance} />}
            {funder && <DetailRow label="Agency" value={funder} />}
            {cfda && <DetailRow label="CFDA number" value={cfda} />}
          </div>
          {showSource && (
            <a
              href={grant.source_url!}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-block text-sm font-medium text-brand-orange hover:underline"
            >
              View the official posting ↗
            </a>
          )}
        </Card>
      )}
    </div>
  );
}
