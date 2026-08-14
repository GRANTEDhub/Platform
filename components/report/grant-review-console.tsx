import Link from "next/link";
import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import { BRAND, INK, RATING } from "@/lib/brand";
import { sanitizeRichText } from "@/lib/sanitize/html";
import { collapseDuplicatedBlock, previewHtml } from "@/lib/grants/description";
import type { FitFactorView, ReviewFactor } from "@/lib/report/fit-factors";
import type { EligibilityVerdict } from "@/lib/intellengine/eligibility";
import { ALLOWABLE_USES_FALLBACK, type AllowableUses } from "@/lib/grants/allowable-uses";

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
// SHARED WITH THE CLIENT PORTAL. app/portal/grants/[id] mounts this same component, by
// deliberate instruction: the two screens are meant to be pixel-identical so a change to
// one lands on both. Every actionable difference is already a passed-in child —
// `decision`, `concept`, `feedback`, `scoreFactors` — so the portal supplies its own and
// passes null for what a client must not have. NOTHING in the frame itself forks on actor,
// and it should stay that way: the moment this file grows an `isClient` branch, the two
// screens start drifting and the reason for sharing it is gone.

export interface ReviewMeta {
  label: string;
  value: string;
  // Rendered as a filled red cell. The ONLY tone this row has, and it exists for one
  // fact: the deadline is today or gone. A closed grant used to render its date in the
  // same navy as the award range and the term, so the single piece of information that
  // invalidates the whole page read as ordinary metadata — and the page's three
  // terminal actions sat one click away.
  tone?: "danger";
}

export interface ReviewKeyDetail {
  label: string;
  value: string;
}

export function GrantReviewConsole({
  backHref,
  backLabel = "Grant Report",
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
  allowableUses = null,
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
  // The portal reaches this screen from Grant Alerts as well as from the Report, so a
  // hardcoded "Grant Report" strands the Alerts path. Same slot, same styling.
  backLabel?: string;
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
  // What the money may be spent on (migration 0072), already read through
  // readAllowableUses() by the page. NULL MEANS RENDER NOTHING AT ALL, which is how the
  // client portal passes it while ALLOWABLE_USES_CLIENT_VISIBLE is off — distinct from a
  // parsed value with an empty items array, which renders the "Ask our team" sentinel
  // because we DID look and the NOFO did not say. Defaults to null so a caller that
  // forgets it shows nothing rather than a half-built section.
  allowableUses?: AllowableUses | null;
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
  //
  // POPULATED ON BOTH SIDES, BUT NEVER A FEEDBACK CONTROL ON THE PORTAL. Score feedback is staff calibration — it writes match_feedback
  // attributed to a profiles row, which a portal member does not have, so it would 403 on
  // press. The client's equivalent already exists as the optional reason on a Pass in
  // DecisionBar, which routes to the same calibration store.
  feedback: React.ReactNode | null;
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
            {backLabel}
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
              allowableUses={allowableUses}
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
  allowableUses,
}: {
  tags: string[];
  agencyLine: string | null;
  title: string;
  summary: string | null;
  meta: ReviewMeta[];
  eligibility: EligibilityVerdict;
  allowableUses: AllowableUses | null;
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

      <AllowableUsesBlock value={allowableUses} />

      {meta.length > 0 && (
        <div className="mt-[13px] flex flex-wrap items-start gap-y-3 border-t border-hairline-strong pt-3">
          {meta.map((m) => (
            // pr-4 and a 2-line clamp, because period_of_performance is free text and can
            // run long ("Up to 5 years (expected start 9/30/2026, end 9/29/2031)"). Without
            // the gutter a wrapped value ran straight into the next cell's figure, so
            // "Awards expected 91" read as part of the term.
            // The cell keeps the SAME flex sizing whatever its tone — the tint goes on an
            // inner wrapper instead. Painting this div meant the fill inherited flex-1 and
            // ran the full width of the cell's basis, so a short date sat in a red band
            // stretching to the next column and read as a broken layout rather than a flag.
            <div key={m.label} className="min-w-[110px] flex-1 pr-4">
              {m.tone === "danger" ? (
                // inline-block so it hugs the two lines it contains. Filled rather than
                // outlined: an outline at this size reads as a focus ring, and the cell has
                // to win against four neighbours at the same weight.
                <span
                  className="inline-block rounded-sharp px-2 py-1"
                  style={{ backgroundColor: BRAND.reject }}
                >
                  {/* white/90, not the /55–/72 the ink surfaces use for an eyebrow: on this
                      fill those land at 3.6–3.9:1 and this is 10px bold uppercase, the
                      worst case for it. /90 is 4.72:1. Case and tracking carry the
                      hierarchy here, not opacity. */}
                  <span className={`block ${EYEBROW} !text-white/90`}>{m.label}</span>
                  <span className="mt-[3px] block text-[14px] font-semibold tabular-nums text-white">
                    {m.value}
                  </span>
                </span>
              ) : (
                <>
                  <p className={EYEBROW}>{m.label}</p>
                  <p
                    className="mt-[5px] line-clamp-2 text-[14px] font-semibold tabular-nums text-brand-navy"
                    title={m.value}
                  >
                    {m.value}
                  </p>
                </>
              )}
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

// What the money may be spent on. Every line is a verbatim-verified read of the NOFO
// (lib/grants/allowable-uses.ts) — nothing here is paraphrased into existence, which is why
// it can sit this close to the programme summary without being mistaken for more of it.
//
// THREE STATES, and the distinction is the point:
//   null            -> render nothing. The caller is not showing this section at all (the
//                      client portal while the flag is off, or a page that never passes it).
//   items non-empty -> the list.
//   items empty     -> the sentinel. We looked and the NOFO did not say plainly, which is a
//                      different statement from silence and is the one a client can act on
//                      by asking. `reason` is deliberately NOT surfaced here: no-section,
//                      no-raw-text and all-dropped are OUR diagnostics, and telling a client
//                      "the model's quotes failed verification" would be answering a
//                      question they did not ask with information they cannot use.
//
// The quote rides in `title` rather than on the page. It is the evidence, not the content:
// a reader who wants to check a line can hover it, and a reader who does not is spared a
// block quote per bullet. Staff get the same treatment as clients here on purpose — if the
// quote is not good enough to show a client, it should not have passed the gate.
function AllowableUsesBlock({ value }: { value: AllowableUses | null }) {
  if (!value) return null;

  return (
    <div className="mt-[13px] border-t border-hairline-strong pt-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Allowable uses of funds</h2>
      {value.items.length === 0 ? (
        <p className="mt-2 text-[13px] leading-[1.6] text-ink-muted">{ALLOWABLE_USES_FALLBACK}</p>
      ) : (
        <ul className="mt-2 space-y-[5px]">
          {value.items.map((item) => (
            <li
              key={item.line}
              className="flex gap-2 text-[13px] leading-[1.55] text-ink-muted [text-wrap:pretty]"
              // The verbatim NOFO span this line came from. Absent only on rows written
              // before quotes were stored, so the attribute is conditional rather than an
              // empty tooltip.
              title={item.quote || undefined}
            >
              <span aria-hidden="true" className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-brand-orange" />
              <span className="min-w-0">{item.line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
          shipping any change to the card above.

          overflow-y-auto BECAUSE ROWS CAN STILL GROW FROM THE INSIDE. The hover pop-out is an
          overlay and never participates in layout — but the UNASSESSED-factor branch renders its
          full rationale INLINE, in normal flow, and enforceFactorDataFloors can mark up to three
          factors insufficient_data at once on a sparse client record, so the six-row budget is
          genuinely exceedable. The parent <section> is a fixed-height overflow-hidden box, so
          without a scrollbar here those inline rows (or the pinned footnote) clip with no way to
          recover them. Scrolling is the recovery. The styled hover pop-out may be clipped by this
          container the same way match-score.tsx accepts for its own tooltip; the native `title` on
          each hover row is the clip-proof fallback that always reveals on hover. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-3.5">
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
// One factor row, and the reason behind it.
//
// THE RATIONALE IS A HOVER POP-OUT (restored, per Shannon), matching the sibling
// match-score.tsx. An ASSESSED row reveals its reason in a styled group-hover pop-out and ALSO
// carries a native `title`: the pop-out is the nice version but can be clipped by the card's
// fixed-height overflow, so the `title` is the always-renders fallback (the exact accepted
// tradeoff match-score.tsx documents). Known cost of hover: no reveal on touch — accepted here
// because the primary rationale is always visible above in RationaleCard and the sr-only span
// still carries the full text to assistive tech. This was previously a <details>/<summary>
// disclosure; hover was chosen back over it deliberately, so keep the two factor surfaces on the
// one hover pattern rather than reintroducing a second mechanism here.
//
// AND WHEN THERE IS NO RATIONALE, THE ROW SAYS SO. `rationale` is required in the scorer's
// tool schema, so a null should be rare — but silence is exactly what cost two debugging
// rounds, so absence is now stated rather than rendered as a control that does nothing.
function FactorRow({ factor, last }: { factor: ReviewFactor; last: boolean }) {
  // An unassessed row already prints its reason in full (see below), so revealing it on hover
  // would hide text that is deliberately always visible.
  const inline = factor.filled === 0 && !!factor.rationale;
  const hover = !!factor.rationale && !inline;
  const rowStyle = factor.lead
    ? { backgroundColor: "rgba(228,118,31,0.07)", margin: "0 -20px", padding: "4px 20px" }
    : undefined;

  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] text-brand-navy ${factor.lead ? "font-semibold" : ""}`}>
          {factor.label}
          {/* NAMES THE CREAM HIGHLIGHT. Exactly one row lights, and it is the factor
              capping the score — the same one the rationale paragraph above bolds. Without
              a label the tint reads as a rendering glitch on a random row, which is how it
              was reported. */}
          {factor.lead && (
            <span
              className="ml-2 align-[1px] text-[9px] font-bold uppercase tracking-[0.1em]"
              style={{ color: BRAND.orangeDeep }}
            >
              caps the score
            </span>
          )}
        </span>
        {/* THE REASON, VISIBLE, on an unassessed row only. "Not assessed" with the
            explanation hidden behind a control is unactionable — and the explanation is
            almost always a CLIENT-RECORD GAP, not a scorer failure. enforceFactorDataFloors
            writes exactly this sentence when the fields a factor depends on are blank
            ("No annual budget or match/cost-share capacity on file."), so the row can point
            at what to go fill in rather than just reporting a hole. */}
        {inline && (
          <span className="mt-[3px] block text-[11px] leading-[1.4] text-ink-muted [text-wrap:pretty]">
            {factor.rationale}
          </span>
        )}
        {!factor.rationale && (
          <span className="mt-[3px] block text-[10.5px] italic leading-[1.4] text-ink-faint">
            No rationale recorded for this factor.
          </span>
        )}
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
    </>
  );

  const srOnly = (
    <span className="sr-only">
      {factor.label}: {factor.word}
      {factor.rationale ? `. ${factor.rationale}` : ". No rationale recorded."}
    </span>
  );

  // HOVER-TO-REVEAL (restored, per Shannon): the rationale rides a desktop CSS group-hover
  // pop-out over the row, matching match-score.tsx. The overlay does NOT participate in layout,
  // so the six-row budget holds and no ancestor's flow grows. A native `title` on the row is the
  // clip-proof fallback -- the styled pop-out can still be clipped by the card's fixed-height
  // overflow, but the title always reveals on hover. (The inline-full unassessed row and the
  // no-rationale row are unchanged and never get a pop-out.)
  return (
    <div
      title={hover ? factor.rationale ?? undefined : undefined}
      className={`group relative flex items-start justify-between gap-3.5 py-1 ${hover ? "cursor-help" : ""} ${
        last ? "" : "border-b border-brand-navy/[0.05]"
      }`}
      style={rowStyle}
    >
      {content}
      {srOnly}
      {hover && (
        <div className="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden max-w-[262px] rounded-lg bg-brand-navy px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg group-hover:block">
          {factor.rationale}
          <span className="absolute right-6 top-full h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-brand-navy" />
        </div>
      )}
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
  feedback: React.ReactNode | null;
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
