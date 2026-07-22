import Link from "next/link";
import { ChevronDown, Check, AlertTriangle } from "lucide-react";
import { sanitizeRichText } from "@/lib/sanitize/html";
import { previewHtml, collapseDuplicatedBlock } from "@/lib/grants/description";
import { ExpandableDescription } from "@/components/grants/expandable-description";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { SectionLabel } from "@/components/ui/section-label";
import type { Grant, IdealApplicantProfile as IAP } from "@/types/database";
import {
  formatAwardRange,
  compactCostShare,
  formatDeadline,
  formatDeadlineShort,
  idealBudget,
  collectRisks,
  rubricRows,
} from "@/lib/grants/format";

// Shared grant-detail presentation (visual refresh, epic #92). The grant body is
// the floating-card language: stat tiles, orange section labels on white cards, a
// warm make-or-break callout, and soft collapsibles. Used by both the Matches
// review Grant tab (/review/[id]) and the Prospects grant detail (/intel/[id]) so
// the two render identically. No client JS -- collapsibles are native <details>.

// SectionLabel now lives in the shared ui layer; re-exported so existing importers
// (`@/components/grants/grant-detail`) keep working.
export { SectionLabel };

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
  | "scoring_rubric" | "ideal_applicant_profile" | "grant_status"
>;

/* ── Generic primitives ───────────────────────────────────────────────────── */

export function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right text-brand-navy">{v}</span>
    </div>
  );
}

// Warm orange-tinted callout with an orange left rule; serif body. Self-contained
// (parent controls spacing via a stack).
export function KeyCallout({ label, icon, children }: { label?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border-l-[3px] border-brand-orange bg-brand-orange/[0.07] px-6 py-5">
      {label && <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{icon}{label}</p>}
      <p className={`${label ? "mt-2 " : ""}font-serif text-[17px] leading-snug text-brand-navy`}>{children}</p>
    </div>
  );
}

// Native <details> collapsible, styled as a floating card (collapsed by default,
// no client JS).
export function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-2xl bg-white shadow-soft">
      <summary className="flex cursor-pointer items-center justify-between px-6 py-4 [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-6 pb-5 pt-0">{children}</div>
    </details>
  );
}

/* ── Grant-body blocks (read grant fields) ────────────────────────────────── */

// The four defining grant facts, formatted once. Rendered as tiles either inside
// the NavyHero (tone="onHero") or as floating cards in the body (tone="onLight").
// Real deadline sub-label ("28 days left · 2026") derived from submission_deadline.
// null when the deadline doesn't parse (rolling / TBD) so the tile shows no line.
function deadlineSublabel(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime()) || !/\d{4}/.test(s)) return null;
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  const year = d.getFullYear();
  if (days < 0) return `Closed · ${year}`;
  if (days === 0) return `Due today · ${year}`;
  return `${days} day${days === 1 ? "" : "s"} left · ${year}`;
}

function grantStatItems(grant: GrantDetailFields, compactDate = false): { label: string; value: string; hint?: string; accent?: boolean }[] {
  const cs = compactCostShare(grant.cost_share);
  // Hero tiles are narrow -> use the abbreviated date so it never wraps; the wide
  // onLight tiles keep the full-month date.
  const deadline = compactDate ? formatDeadlineShort(grant.submission_deadline) : formatDeadline(grant.submission_deadline);
  return [
    { label: `Award range${grant.award_range_is_estimate ? " · est." : ""}`, value: formatAwardRange(grant.award_range_min, grant.award_range_max), hint: "Per project" },
    { label: "Est. awards", value: grant.num_awards || "—", hint: "This NOFO" },
    { label: "Match required", value: cs, hint: cs === "None" ? "No cost share" : "Cost share" },
    { label: "Deadline", value: deadline, hint: deadlineSublabel(grant.submission_deadline) ?? undefined, accent: true },
  ];
}

export function GrantStatTiles({ grant, tone = "onLight" }: { grant: GrantDetailFields; tone?: "onLight" | "onHero" }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {grantStatItems(grant, tone === "onHero").map((it, i) => (
        <Stat key={i} tone={tone} accent={it.accent} label={it.label} value={it.value} hint={it.hint} />
      ))}
    </div>
  );
}

// Real grant status -> a hero pill. Derived from grant.grant_status (no invented
// state); styled for the dark hero. Renders nothing when status is absent.
export function GrantStatusPill({ status }: { status: string | null | undefined }) {
  const s = (status ?? "").trim().toLowerCase();
  let label: string;
  let dot: string;
  if (/^(active|posted|open)/.test(s)) { label = "Open · Accepting applications"; dot = "bg-emerald-400"; }
  else if (/forecast/.test(s)) { label = "Forecasted"; dot = "bg-amber-400"; }
  else if (/(closed|archiv|expired|inactive)/.test(s)) { label = "Closed"; dot = "bg-white/40"; }
  else if (s) { label = (status ?? "").trim(); dot = "bg-white/40"; }
  else return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function WhatItFunds({ grant, label = "What it funds" }: { grant: GrantDetailFields; label?: string }) {
  // Description may carry HTML markup -> sanitize (whitelist) then inject. Long
  // descriptions are truncated (sentence-clean) with a Show more expander.
  const descClean = grant.description ? sanitizeRichText(collapseDuplicatedBlock(grant.description)) : "";
  const descPreview = previewHtml(descClean);
  const descClass = "mt-3 text-sm leading-relaxed text-foreground [&_li]:ml-4 [&_li]:list-disc [&_ol]:mt-2 [&_ol]:list-decimal [&_p]:mt-2 [&_ul]:mt-2";
  return (
    <Card className="p-6 sm:p-7">
      <SectionLabel>{label}</SectionLabel>
      {!grant.description ? (
        <p className="mt-3 text-sm leading-relaxed text-foreground">—</p>
      ) : descPreview.truncated ? (
        <ExpandableDescription preview={descPreview.html} full={descClean} className={descClass} />
      ) : (
        <div className={descClass} dangerouslySetInnerHTML={{ __html: descClean }} />
      )}
    </Card>
  );
}

// "Who can apply" -- eligible-entity chips + Geography/Ineligible split cards +
// subaward note. Split out of the old WhatItFundsAndEligibility so the review page
// can float it in its narrow right rail (`dense`); the prospects grant body still
// renders it inline (wide, two-column geo/ineligible) via GrantBody.
export function WhoCanApply({ grant, dense = false, label = "Who can apply" }: { grant: GrantDetailFields; dense?: boolean; label?: string }) {
  const eligibleTypes = (grant.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " "));
  return (
    <Card className={dense ? "p-5" : "p-6 sm:p-7"}>
      <SectionLabel>{label}</SectionLabel>
      {eligibleTypes.length > 0 ? (
        // dense (rail): stack one chip per row so nothing sits two-across; the wide
        // prospects-body variant keeps wrapping.
        <div className={`mt-3 flex gap-1.5 ${dense ? "flex-col items-start" : "flex-wrap"}`}>
          {eligibleTypes.map((t, i) => (
            <Badge key={i} variant="chip" className="gap-1">
              <Check className="h-3 w-3 text-emerald-600" strokeWidth={3} />
              {t}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Eligible entity types not specified.</p>
      )}
      {(grant.geographic_eligibility || grant.ineligible_entities) && (
        <div className={`mt-4 grid gap-3 ${dense ? "grid-cols-1" : "sm:grid-cols-2"}`}>
          {grant.geographic_eligibility && (
            <div className="rounded-2xl bg-emerald-50 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">Geography</p>
              <p className="mt-1.5 text-sm text-foreground">{grant.geographic_eligibility}</p>
            </div>
          )}
          {grant.ineligible_entities && (
            <div className="rounded-2xl bg-brand-orange/[0.07] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-brand-orange">Ineligible</p>
              <p className="mt-1.5 text-sm text-foreground">{grant.ineligible_entities}</p>
            </div>
          )}
        </div>
      )}
      {grant.subaward_prohibited && <p className="mt-3 text-sm font-medium text-brand-orange">Subawards prohibited</p>}
    </Card>
  );
}

export function MakeOrBreak({ grant }: { grant: GrantDetailFields }) {
  if (!grant.incumbent_risk) return null;
  return <KeyCallout label="Make-or-break" icon={<AlertTriangle className="h-3.5 w-3.5" />}>{grant.incumbent_risk}</KeyCallout>;
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
                  {a.partner_seats.map((s, j) => <Badge key={j} variant="chip">+ {s}</Badge>)}
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

// The full styled grant body, in order, as floating cards on cream. `showStats`
// renders the stat tiles at the top -- the review page sets it false because the
// tiles live in its NavyHero instead; the prospects page keeps them in the body.
export function GrantBody({
  grant,
  showStats = true,
  showWhoCanApply = true,
}: {
  grant: GrantDetailFields;
  showStats?: boolean;
  showWhoCanApply?: boolean;
}) {
  return (
    <div className="space-y-6">
      {showStats && <GrantStatTiles grant={grant} tone="onLight" />}
      <WhatItFunds grant={grant} />
      {showWhoCanApply && <WhoCanApply grant={grant} />}
      <MakeOrBreak grant={grant} />
      <IdealApplicantProfile grant={grant} />
      <AdditionalInformation grant={grant} />
      <RiskFactors grant={grant} />
    </div>
  );
}
