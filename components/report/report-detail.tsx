import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { DecisionBadge } from "@/components/grants/badges";
import { GrantBody, type GrantDetailFields } from "@/components/grants/grant-detail";
import { ScoreRing, FactorMark, Tag } from "./primitives";
import { FIT_BAND, factorViews, factorDisplay } from "@/lib/report/shape";
import type { CardDecision, FactorScores } from "@/types/database";

// Read-only Grant Report detail — the shared decision surface's display half
// (Slice 1). One component, mounted in the client portal now and reusable by the
// staff account-manager view later; decisions/feedback layer on in Slice 2. It
// reuses the same GrantBody the staff review page renders, so the grant facts read
// identically across surfaces.

export interface ReportDetailCard {
  fit_score: 1 | 2 | 3;
  proposed_role: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  factor_scores: FactorScores | null;
  decision: CardDecision;
}

export function ReportDetail({
  card,
  grant,
  title,
  funder,
  focusAreas,
  backHref,
  backLabel = "Back to roadmap",
}: {
  card: ReportDetailCard;
  grant: GrantDetailFields;
  title: string;
  funder: string | null;
  focusAreas: string[];
  backHref: string;
  backLabel?: string;
}) {
  const band = FIT_BAND[card.fit_score] ?? FIT_BAND[1];
  const factors = factorViews(card.factor_scores);
  const hasFactors = factors.some((f) => f.rating !== null);
  const why = (card.why_this_org ?? []).filter(Boolean);

  return (
    <div className="animate-fade-up space-y-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      {/* header */}
      <div className="rounded-3xl bg-white p-8 shadow-soft">
        <div className="flex items-start gap-6">
          <ScoreRing fitScore={card.fit_score} band={band} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-[28px] font-semibold leading-tight tracking-tight text-brand-navy">{title}</h1>
              {card.decision !== "pending" && <DecisionBadge decision={card.decision} />}
            </div>
            {funder && <p className="mt-1 text-[15px] text-muted-foreground">{funder}</p>}
            {(card.proposed_role || focusAreas.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {card.proposed_role && <Tag>{card.proposed_role}</Tag>}
                {focusAreas.map((f, i) => (
                  <Tag key={i}>{f}</Tag>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* why this fits */}
      {(why.length > 0 || card.concept_synopsis) && (
        <Card className="p-6 sm:p-7">
          <SectionLabel>Why this fits you</SectionLabel>
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
            <p className="mt-4 border-t border-brand-navy/[0.06] pt-4 text-sm leading-relaxed text-foreground">
              {card.concept_synopsis}
            </p>
          )}
        </Card>
      )}

      {/* fit breakdown */}
      <Card className="p-6 sm:p-7">
        <SectionLabel>Fit breakdown</SectionLabel>
        {hasFactors ? (
          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {factors.map((f) => {
              const d = factorDisplay(f.rating);
              return (
                <div key={f.key} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                    <FactorMark mark={d.mark} className={d.className} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-brand-navy">
                      {f.label}
                      <span className={`ml-2 text-xs font-medium ${d.className}`}>{d.word}</span>
                    </p>
                    {f.rationale && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{f.rationale}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            A detailed fit breakdown isn&apos;t available for this match yet.
          </p>
        )}
      </Card>

      {/* the grant itself — same body the staff review renders */}
      <GrantBody grant={grant} />
    </div>
  );
}
