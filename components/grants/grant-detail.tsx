import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { sanitizeRichText } from "@/lib/sanitize/html";
import type { Grant, IdealApplicantProfile as IAP } from "@/types/database";
import {
  formatAwardRange,
  compactCostShare,
  formatDeadline,
  idealBudget,
  collectRisks,
  rubricRows,
} from "@/lib/grants/format";

// Shared grant-detail presentation. The styled grant body (navy stat-band, orange
// section labels, make-or-break callout, Ideal Applicant Profile, Additional
// information, Risk) is rendered from these so the Matches review Grant tab and
// the Prospects grant detail stay identical. No client JS -- collapsibles are
// native <details>.

const RUBRIC_CAP = 8;

// The subset of Grant these blocks read. Both callers select at least these
// fields; a full Grant is structurally assignable.
export type GrantDetailFields = Pick<
  Grant,
  | "id" | "source_url"
  | "submission_deadline" | "period_of_performance"
  | "cost_share" | "award_range_min" | "award_range_max" | "award_range_is_estimate"
  | "num_awards" | "description"
  | "eligible_entity_types" | "geographic_eligibility" | "ineligible_entities" | "subaward_prohibited"
  | "incumbent_risk" | "technical_burden_flags" | "hard_disqualifiers" | "verification_flags"
  | "scoring_rubric" | "ideal_applicant_profile"
>;

/* ── Generic primitives ───────────────────────────────────────────────────── */

// Signature navy stat-band; most-urgent cell in burnt orange. Values NEVER wrap
// or resize the cell -- they truncate to one line (full text on hover).
export function StatBand({ items }: { items: { label: string; value: string; urgent?: boolean }[] }) {
  return (
    <div className="flex overflow-hidden rounded-xl">
      {items.map((it, i) => (
        <div key={i} className={`min-w-0 flex-1 px-4 py-3.5 ${it.urgent ? "bg-brand-orange" : "bg-brand-navy"} ${i > 0 ? "border-l border-white/10" : ""}`}>
          <p className={`truncate text-[10px] uppercase tracking-[0.08em] ${it.urgent ? "text-white/75" : "text-white/55"}`}>{it.label}</p>
          <p className="mt-1 truncate font-serif text-lg font-semibold leading-tight text-white" title={it.value}>{it.value}</p>
        </div>
      ))}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{children}</p>;
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-brand-navy/[0.06] px-2.5 py-0.5 text-xs text-brand-navy/85">{children}</span>;
}

export function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right text-brand-navy">{v}</span>
    </div>
  );
}

// Cream / orange-left-border callout. `tight` drops the top margin when it leads
// a section that already has a label above it.
export function KeyCallout({ label, tight, children }: { label?: string; tight?: boolean; children: React.ReactNode }) {
  return (
    <div className={`${tight ? "mt-3" : "mt-6"} rounded-r-lg border-l-[3px] border-brand-orange bg-brand-cream px-4 py-3.5`}>
      {label && <p className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-brand-orange">{label}</p>}
      <p className={`${label ? "mt-1.5 " : ""}font-serif text-[17px] leading-snug text-brand-navy`}>{children}</p>
    </div>
  );
}

// Native <details> collapsible (collapsed by default, no client JS).
export function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group mt-6 overflow-hidden rounded-xl border border-brand-navy/10">
      <summary className="flex cursor-pointer items-center justify-between bg-brand-navy/[0.02] px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

/* ── Grant-body blocks (read grant fields) ────────────────────────────────── */

export function GrantStatBand({ grant }: { grant: GrantDetailFields }) {
  return (
    <StatBand
      items={[
        { label: `Award range${grant.award_range_is_estimate ? " · est." : ""}`, value: formatAwardRange(grant.award_range_min, grant.award_range_max) },
        { label: "Est. awards", value: grant.num_awards || "—" },
        { label: "Match required", value: compactCostShare(grant.cost_share) },
        { label: "Deadline", value: formatDeadline(grant.submission_deadline), urgent: true },
      ]}
    />
  );
}

export function WhatItFundsAndEligibility({ grant }: { grant: GrantDetailFields }) {
  const eligibleTypes = (grant.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " "));
  return (
    <div className="mt-8 grid gap-8 md:grid-cols-2">
      <section>
        <SectionLabel>What it funds</SectionLabel>
        {grant.description ? (
          // Description may carry HTML markup -> sanitize (whitelist) then inject,
          // rendered in a div so block tags nest validly.
          <div
            className="mt-2.5 text-sm leading-relaxed text-foreground [&_li]:ml-4 [&_li]:list-disc [&_ol]:mt-2 [&_ol]:list-decimal [&_p]:mt-2 [&_ul]:mt-2"
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(grant.description) }}
          />
        ) : (
          <p className="mt-2.5 text-sm leading-relaxed text-foreground">—</p>
        )}
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
          {grant.geographic_eligibility && <p><span className="text-muted-foreground">Geography: </span>{grant.geographic_eligibility}</p>}
          {grant.ineligible_entities && <p><span className="text-muted-foreground">Ineligible: </span>{grant.ineligible_entities}</p>}
          {grant.subaward_prohibited && <p className="font-medium text-brand-orange">Subawards prohibited</p>}
        </div>
      </section>
    </div>
  );
}

export function MakeOrBreak({ grant }: { grant: GrantDetailFields }) {
  if (!grant.incumbent_risk) return null;
  return <KeyCallout label="Make-or-break">{grant.incumbent_risk}</KeyCallout>;
}

// Clean pull from grants.ideal_applicant_profile; consortium block renders only
// when archetypes exist, so a null/empty profile omits gracefully.
export function IdealApplicantProfile({ grant }: { grant: GrantDetailFields }) {
  const iap = grant.ideal_applicant_profile as IAP | null | undefined;
  if (!iap || !(iap.summary || iap.core_funded_role || (iap.archetypes?.length ?? 0) > 0)) return null;
  const budget = idealBudget(grant);
  return (
    <Collapsible label="Ideal Applicant Profile">
      {iap.summary && <p className="text-sm leading-relaxed text-foreground">{iap.summary}</p>}
      {(grant.period_of_performance || budget || iap.core_funded_role) && (
        <div className="mt-3 space-y-1 border-t border-brand-navy/[0.08] pt-3">
          {grant.period_of_performance && <InfoRow k="Term" v={grant.period_of_performance} />}
          {budget && <InfoRow k="Budget" v={budget} />}
          {iap.core_funded_role && <InfoRow k="Core funded role" v={iap.core_funded_role} />}
        </div>
      )}
      {(iap.archetypes?.length ?? 0) > 0 && (
        <div className="mt-3 space-y-3 border-t border-brand-navy/[0.08] pt-3">
          {iap.archetypes.map((a, i) => (
            <div key={i}>
              <p className="text-sm font-semibold text-brand-navy">{a.label}</p>
              {a.ideal_prime_shape && <p className="mt-0.5 text-sm text-muted-foreground">{a.ideal_prime_shape}</p>}
              {(a.partner_seats?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.partner_seats.map((s, j) => <Chip key={j}>+ {s}</Chip>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {iap.eligibility_note && <p className="mt-3 text-xs text-muted-foreground">{iap.eligibility_note}</p>}
    </Collapsible>
  );
}

export function AdditionalInformation({ grant }: { grant: GrantDetailFields }) {
  const allRubric = rubricRows(grant.scoring_rubric as Record<string, unknown> | null);
  const rubric = allRubric.slice(0, RUBRIC_CAP);
  const rubricMore = allRubric.length - rubric.length;
  const postingLabel = grant.source_url && /simpler\.grants\.gov/i.test(grant.source_url) ? "View on Simpler.gov ↗" : "View posting ↗";
  const showSource = grant.source_url && grant.source_url !== "manual-paste";
  if (!(grant.period_of_performance || rubric.length > 0 || showSource || grant.id)) return null;
  return (
    <Collapsible label="Additional information">
      {grant.period_of_performance && (
        <div className="flex justify-between gap-3 border-b border-brand-navy/[0.08] pb-2.5 text-sm">
          <span className="text-muted-foreground">Period of performance</span>
          <span className="text-right text-brand-navy">{grant.period_of_performance}</span>
        </div>
      )}
      {rubric.length > 0 && (
        <div className="border-b border-brand-navy/[0.08] py-2.5">
          <p className="text-sm text-muted-foreground">Scoring rubric</p>
          <div className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
            {rubric.map((r, i) => (
              <div key={i} className="flex justify-between gap-3 text-sm">
                <span className="text-brand-navy/85">{r.name}</span>
                {r.points && <span className="shrink-0 text-brand-navy">{r.points}</span>}
              </div>
            ))}
          </div>
          {rubricMore > 0 && <p className="mt-2 text-xs text-muted-foreground">+{rubricMore} more categories</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-3 text-sm font-medium">
        {showSource && (
          <a href={grant.source_url!} target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">{postingLabel}</a>
        )}
        {grant.id && <Link href={`/grants/${grant.id}`} className="text-brand-orange hover:underline">Open Shred →</Link>}
      </div>
    </Collapsible>
  );
}

export function RiskFactors({ grant }: { grant: GrantDetailFields }) {
  const risks = collectRisks(grant);
  if (risks.length === 0) return null;
  return (
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
  );
}

// The full styled grant body, in order. Both pages drop this into their main
// column; page-specific chrome (tabs, decision panel, prospects list) wraps it.
export function GrantBody({ grant }: { grant: GrantDetailFields }) {
  return (
    <div>
      <GrantStatBand grant={grant} />
      <WhatItFundsAndEligibility grant={grant} />
      <MakeOrBreak grant={grant} />
      <IdealApplicantProfile grant={grant} />
      <AdditionalInformation grant={grant} />
      <RiskFactors grant={grant} />
    </div>
  );
}
