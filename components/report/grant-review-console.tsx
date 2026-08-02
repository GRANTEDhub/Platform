import Link from "next/link";
import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import { BRAND, INK, RATING } from "@/lib/brand";
import { sanitizeRichText } from "@/lib/sanitize/html";
import { collapseDuplicatedBlock, previewHtml } from "@/lib/grants/description";
import type { FitFactorView, ReviewFactor } from "@/lib/report/fit-factors";
import type { EligibilityVerdict } from "@/lib/intellengine/eligibility";

// The grant review screen — one matched grant, one client, one decision.
//
// IT ANSWERS THREE QUESTIONS IN ORDER: is this worth sending, is the machine's score
// right, and should we draft a concept first. The reviewer arrives from the client's
// Grant Report and leaves the moment they decide, dozens of times a morning, so nothing
// here may require scrolling to reach.
//
// THE PAGE MAKES ONE ARGUMENT and the layout exists to carry it: this grant is capped for
// exactly one reason, and the fix already exists. Score → weakness → mitigation is a
// single chain, and the surface this replaces scattered it across four screens without
// ever stating it. Three things carry it now — the rationale paragraph states it in prose
// with the blocking sentence in bold, the fit factors light exactly one row so the eye
// finds the blocker without reading, and the concept proposal exists to carry the
// mitigation to the client. Do not let copy edits erase the bold sentence or spread the
// orange to a second factor.
//
// STAFF ONLY. The client's own copy of this grant is app/portal/grants/[id], which still
// renders ReportDetail — this is deliberately a separate surface rather than a variant,
// because the client's page has different visibility rules and none of these controls.

export interface ReviewMeta {
  label: string;
  value: string;
}

export interface ReviewKeyDetail {
  label: string;
  value: string;
}

export function GrantReviewConsole({
  backHref,
  clientName,
  clientMonogram,
  clientMeta,
  queueLine,
  tags,
  agencyLine,
  title,
  summary,
  meta,
  eligibility,
  rationale,
  factors,
  scoreFactors,
  fitScore,
  verdict,
  consequence,
  scoreFootnote,
  feedback,
  decision,
  concept,
  keyDetails,
  sourceUrl,
}: {
  backHref: string;
  clientName: string;
  clientMonogram: string;
  clientMeta: string | null;
  // "Match surfaced Jul 28 · 9 more awaiting review" — assembled by the caller, which
  // owns both facts. Null when neither is known.
  queueLine: React.ReactNode | null;
  tags: string[];
  agencyLine: string | null;
  title: string;
  // The programme narrative, parsed from the NOFO. Not a one-liner: what the funder is
  // buying, what awardees must do, how it is measured.
  //
  // RAW grants.description, markup and all. Sanitizing happens INSIDE this component on
  // purpose: source descriptions carry HTML, and the first build of this screen rendered
  // the field as an escaped React child, which printed literal <p><span style=...> tags
  // on the page. Owning the sanitize here means no future caller can reintroduce that by
  // passing the field straight through.
  summary: string | null;
  meta: ReviewMeta[];
  eligibility: EligibilityVerdict;
  // Prose. `blocking` is bolded inside it — see the note at the top of this file.
  rationale: { lead: string | null; blocking: string | null; mitigation: string | null };
  factors: FitFactorView;
  // The backfill control for a card with no per-factor breakdown. A client component,
  // passed in, and null on any surface that should not be able to spend a scorer call.
  // Rendered ONLY in the unscored branch — a scored card never sees it.
  scoreFactors: React.ReactNode | null;
  fitScore: 1 | 2 | 3;
  verdict: string;
  consequence: string | null;
  scoreFootnote: string;
  // The agree/disagree control. A client component, passed in.
  feedback: React.ReactNode;
  // Release / reject. A client component, passed in.
  decision: React.ReactNode;
  // The concept proposal card. A client component, passed in.
  concept: React.ReactNode | null;
  keyDetails: ReviewKeyDetail[];
  sourceUrl: string | null;
}) {
  return (
    <div className="flex min-h-full flex-col bg-ground">
      {/* Context bar — chrome continuous with the command band, so it is full-bleed at
          the same 30px gutter rather than inside a content column. */}
      <div className="relative z-[1] flex h-[50px] shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-hairline-strong bg-white px-[30px]">
        <div className="flex min-w-0 items-center gap-3.5">
          <Link
            href={backHref}
            className="inline-flex shrink-0 items-center gap-[7px] rounded-sharp text-[12.5px] font-medium text-ink-muted transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Grant Report
          </Link>
          <span aria-hidden="true" className="h-[18px] w-px shrink-0 bg-brand-navy/[0.12]" />
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sharp bg-brand-chrome text-[10px] font-semibold text-white"
          >
            {clientMonogram}
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-brand-navy">{clientName}</span>
          {clientMeta && <span className="truncate text-[12.5px] capitalize text-ink-muted">{clientMeta}</span>}
        </div>
        {queueLine && <span className="shrink-0 text-[12px] text-ink-muted">{queueLine}</span>}
      </div>

      <div className="relative flex-1 overflow-hidden px-[30px] pb-5 pt-[18px]">
        <Decor ghost={fitScore} />

        {/* grid-template-rows: minmax(0,1fr) is REQUIRED, not tidiness. Without it the
            implicit row sizes to max-content, both columns grow past the frame, and the
            page scrolls — which is the one thing this screen may not do. */}
        <div className="relative z-[1] grid h-full grid-rows-[minmax(0,1fr)] gap-[18px] xl:grid-cols-[1fr_386px]">
          <div className="flex min-h-0 min-w-0 flex-col gap-3.5">
            <OverviewCard
              tags={tags}
              agencyLine={agencyLine}
              title={title}
              summary={summary}
              meta={meta}
              eligibility={eligibility}
            />
            <RationaleCard
              rationale={rationale}
              factors={factors}
              scoreFactors={scoreFactors}
              footnote={scoreFootnote}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-3.5">
            <ScoreCard score={fitScore} verdict={verdict} consequence={consequence} feedback={feedback} />
            {decision}
            {concept}
            <KeyDetailsCard details={keyDetails} sourceUrl={sourceUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Ground ornament: a rule down the column gutter, hairline margins, and the fit score
// bled off the bottom-right at 3% ink. Everything real sits above it.
function Decor({ ghost }: { ghost: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      <span className="absolute inset-y-0 right-[393px] hidden w-px bg-brand-navy/[0.07] xl:block" />
      <span className="absolute inset-y-0 left-0 w-px bg-brand-navy/10" />
      <span className="absolute inset-y-0 right-0 w-px bg-brand-navy/10" />
      <span
        className="absolute -bottom-[150px] -right-[46px] select-none font-serif text-[340px] font-bold leading-none tracking-[-0.04em]"
        style={{ color: "rgba(11,30,58,0.03)" }}
      >
        {ghost}
      </span>
    </div>
  );
}

const CARD = "rounded-sharp border border-edge bg-white";
const EYEBROW = "text-[10px] font-bold uppercase tracking-[0.11em] text-ink-muted";

function OverviewCard({
  tags,
  agencyLine,
  title,
  summary,
  meta,
  eligibility,
}: {
  tags: string[];
  agencyLine: string | null;
  title: string;
  summary: string | null;
  meta: ReviewMeta[];
  eligibility: EligibilityVerdict;
}) {
  return (
    <section className={`shrink-0 ${CARD} px-5 pb-[15px] pt-4`}>
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((t) => (
          <span
            key={t}
            className="rounded-sharp bg-brand-navy/[0.06] px-2 py-[3px] text-[10.5px] font-semibold capitalize text-ink-muted"
          >
            {t}
          </span>
        ))}
        {agencyLine && <span className="ml-auto text-[11.5px] text-ink-muted">{agencyLine}</span>}
      </div>

      {/* Two lines at 22px is the budget. Three pushes the meta row down and the
          rationale card's factor block is what gets clipped — see its note. */}
      <h1 className="mt-[9px] font-serif text-[22px] font-bold leading-[1.25] tracking-[-0.01em] text-brand-navy [text-wrap:pretty]">
        {title}
      </h1>

      <ProgrammeSummary raw={summary} />

      {meta.length > 0 && (
        <div className="mt-[13px] flex flex-wrap items-start gap-y-3 border-t border-hairline-strong pt-3">
          {meta.map((m) => (
            // pr-4 and a 2-line clamp, because period_of_performance is free text and can
            // run long ("Up to 5 years (expected start 9/30/2026, end 9/29/2031)"). Without
            // the gutter a wrapped value ran straight into the next cell's figure, so
            // "Awards expected 91" read as part of the term.
            <div key={m.label} className="min-w-[110px] flex-1 pr-4">
              <p className={EYEBROW}>{m.label}</p>
              <p
                className="mt-[5px] line-clamp-2 text-[14px] font-semibold tabular-nums text-brand-navy"
                title={m.value}
              >
                {m.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ELIGIBILITY FOLDS IN HERE rather than getting a card of its own. It is a
          property of the grant-for-this-client, read once on the way to a decision — a
          separate box gave it the same weight as the decision itself. */}
      <div className="mt-[13px] border-t border-hairline-strong pt-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className={EYEBROW}>Eligibility</p>
          <EligibilityChip verdict={eligibility} />
          {eligibility.matchedType && (
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted" title={eligibility.matchedType}>
              as {eligibility.matchedType.replace(/\.$/, "").toLowerCase()}
            </span>
          )}
          {eligibility.eligibleTypes.length > 1 && (
            <span
              className="ml-auto shrink-0 text-[11.5px] font-semibold text-ink-muted"
              title={eligibility.eligibleTypes.join(" · ")}
            >
              All {eligibility.eligibleTypes.length} entity types
            </span>
          )}
        </div>
        {/* The limits worth checking, verbatim from the NOFO. Never paraphrased: an
            eligibility exclusion restated in our own words is a legal claim we did not
            make. Absent when the extraction found none. */}
        {(eligibility.excluded || eligibility.reasons.length > 0) && (
          <p className="mt-2 line-clamp-2 text-[12px] leading-[1.5] text-ink-muted">
            <strong className="font-semibold" style={{ color: BRAND.orangeDeep }}>
              Limits to check:{" "}
            </strong>
            {eligibility.excluded ?? eligibility.reasons[0]}
          </p>
        )}
      </div>
    </section>
  );
}

// The programme narrative. Sanitized, de-duplicated, and word-capped rather than
// line-clamped: `previewHtml` cuts on a word boundary and closes the tags it left open,
// where a CSS clamp on injected markup can hide a paragraph mid-tag and leave the visible
// text ending on a fragment.
//
// collapseDuplicatedBlock first — several sources repeat the same paragraph twice, and a
// clamp over a duplicate shows the same sentence in both halves of the visible text.
function ProgrammeSummary({ raw }: { raw: string | null }) {
  if (!raw?.trim()) return null;
  const clean = sanitizeRichText(collapseDuplicatedBlock(raw));
  if (!clean.trim()) return null;
  const { html } = previewHtml(clean, 80);
  return (
    <div
      className="mt-2.5 space-y-2 text-[13px] leading-[1.6] text-ink-muted [text-wrap:pretty] [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-brand-navy"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Verdict chip. Neutral, not green — green is retired from this screen, and a green chip
// would also overstate what a keyword match against NOFO prose actually establishes.
function EligibilityChip({ verdict }: { verdict: EligibilityVerdict }) {
  const clears = verdict.level === "eligible";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-sharp bg-brand-navy/[0.06] px-[9px] py-[3px] text-[11.5px] font-semibold text-brand-navy"
      title={verdict.headline}
    >
      {clears && <Check className="h-3 w-3" aria-hidden="true" />}
      {clears ? "Clears entity type" : verdict.level === "ineligible" ? "Structural limit" : "Confirm eligibility"}
    </span>
  );
}

function RationaleCard({
  rationale,
  factors,
  scoreFactors,
  footnote,
}: {
  rationale: { lead: string | null; blocking: string | null; mitigation: string | null };
  factors: FitFactorView;
  scoreFactors: React.ReactNode | null;
  footnote: string;
}) {
  const hasProse = rationale.lead || rationale.blocking || rationale.mitigation;
  return (
    <section className={`flex min-h-0 flex-1 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-2.5 px-5 pb-[11px] pt-[13px]">
        <h2 className="font-serif text-[16px] font-bold text-brand-navy">Match rationale</h2>
        <span className="ml-auto text-[11px] text-ink-muted">Why this grant fits</span>
      </div>

      {hasProse && (
        <div className="shrink-0 px-5 pb-[13px]">
          <p className="text-[13px] leading-[1.65] text-ink-muted [text-wrap:pretty]">
            {rationale.lead && <>{rationale.lead} </>}
            {/* The blocking sentence, in bold, in navy. It is the engine's own rationale
                string for the weakest factor — not a rewrite of it, so the page cannot
                assert a cap the score does not actually rest on. */}
            {rationale.blocking && (
              <strong className="font-semibold text-brand-navy">{rationale.blocking} </strong>
            )}
            {rationale.mitigation}
          </p>
        </div>
      )}

      {/* THE ONLY FLEXIBLE CHILD, so this is what clips if anything above it grows. Row
          padding is 4px and the footnote is pinned — check the six rows still fit before
          shipping any change to the card above. */}
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-3.5">
        <p className={`mb-[3px] border-t border-hairline-strong pt-[11px] ${EYEBROW} tracking-[0.13em]`}>
          Fit factors
        </p>
        {factors.unscored ? (
          // Per-factor sub-scores shipped 2026-07-27 (migration 0038) with no backfill by
          // design, and `factor_scores` is in the scorer tool's required set — so a null
          // can only mean the card was matched before that date.
          //
          // NEITHER OF THE OTHER PATHS FIXES IT: "Refresh matches" skips already-attempted
          // pairs (lib/clients/match-queue.ts) and check-grant returns early when a card
          // already exists. `scoreFactors` is the one control that does, and the copy that
          // used to sit here — "it stays that way unless this pair is scored again" — now
          // lives inside it, next to the button that does the scoring. When the caller
          // passes nothing (no staff control on this surface) the plain statement stands.
          scoreFactors ?? (
            <p className="pt-2 text-[12.5px] leading-[1.5] text-ink-muted">
              No per-factor breakdown — this card was matched before factor scoring shipped
              (27 Jul).
            </p>
          )
        ) : (
          factors.factors.map((f, i) => <FactorRow key={f.key} factor={f} last={i === factors.factors.length - 1} />)
        )}
        <p className="mt-auto pt-[11px] text-[11px] text-ink-muted">{footnote}</p>
      </div>
    </section>
  );
}

// The rating word sits UNDER the bar, not beside it. Beside, the name and the bar pin to
// opposite edges and a gap opens down the middle of the list that the eye reads as a
// column of nothing.
function FactorRow({ factor, last }: { factor: ReviewFactor; last: boolean }) {
  return (
    <div
      className={`flex items-start justify-between gap-3.5 py-1 ${last ? "" : "border-b border-brand-navy/[0.05]"}`}
      style={factor.lead ? { backgroundColor: "rgba(228,118,31,0.07)", margin: "0 -20px", padding: "4px 20px" } : undefined}
    >
      <span
        className={`min-w-0 flex-1 text-[13px] text-brand-navy ${factor.lead ? "font-semibold" : ""}`}
        title={factor.rationale ?? undefined}
      >
        {factor.label}
      </span>
      <div className="shrink-0 text-right">
        <span className="flex gap-[3px]" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2.5 w-11 rounded-sharp"
              style={{
                backgroundColor:
                  i < factor.filled ? (factor.lead ? BRAND.orange : RATING.filled) : RATING.empty,
              }}
            />
          ))}
        </span>
        <p
          className="mt-1 text-[10.5px] font-semibold tracking-[0.03em]"
          style={{ color: factor.lead ? BRAND.orangeDeep : factor.filled === 3 ? INK.DEFAULT : INK.muted }}
        >
          {factor.word}
        </p>
      </div>
      <span className="sr-only">
        {factor.label}: {factor.word}
        {factor.rationale ? `. ${factor.rationale}` : ""}
      </span>
    </div>
  );
}

function ScoreCard({
  score,
  verdict,
  consequence,
  feedback,
}: {
  score: 1 | 2 | 3;
  verdict: string;
  consequence: string | null;
  feedback: React.ReactNode;
}) {
  return (
    <section className="shrink-0 rounded-sharp bg-brand-chrome px-[19px] pb-[15px] pt-4 text-white">
      <div className="flex items-start gap-[15px]">
        <div
          className="flex h-[60px] w-[60px] shrink-0 flex-col items-center justify-center"
          style={{ border: `1px solid ${BRAND.orange}99`, backgroundColor: "rgba(228,118,31,0.16)" }}
        >
          <p className="font-serif text-[28px] font-bold leading-none tabular-nums text-white">{score}</p>
          <p className="mt-0.5 text-[9.5px] font-semibold tracking-[0.06em] text-white/60">OF 3</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-white/[0.55]">Fit score</p>
          {/* The warm accent goes LIGHTER on ink, not darker — see BRAND.amberOnDark. */}
          <p className="mt-[5px] font-serif text-[20px] font-bold" style={{ color: BRAND.amberOnDark }}>
            {verdict}
          </p>
          {consequence && <p className="mt-1.5 text-[11.5px] leading-[1.5] text-white/[0.65]">{consequence}</p>}
        </div>
      </div>
      {feedback}
    </section>
  );
}

function KeyDetailsCard({ details, sourceUrl }: { details: ReviewKeyDetail[]; sourceUrl: string | null }) {
  return (
    <section className={`flex min-h-0 flex-1 flex-col ${CARD} px-[17px] py-3.5`}>
      <p className={`${EYEBROW} tracking-[0.13em]`}>Key details</p>
      <div className="flex flex-1 flex-col justify-around py-1">
        {details.map((d) => (
          <div key={d.label} className="flex items-center justify-between gap-2.5">
            <span className="shrink-0 text-[12px] text-ink-muted">{d.label}</span>
            <span className="min-w-0 truncate text-[12px] font-semibold tabular-nums text-brand-navy" title={d.value}>
              {d.value}
            </span>
          </div>
        ))}
      </div>
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-[7px] border-t border-hairline-strong pt-[11px] text-[12px] font-semibold transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
          style={{ color: BRAND.orangeDeep }}
        >
          <ExternalLink className="h-[13px] w-[13px]" aria-hidden="true" />
          View the official posting
        </a>
      )}
    </section>
  );
}
