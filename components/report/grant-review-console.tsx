import Link from "next/link";
import { ArrowLeft, Ban, Check, ChevronRight, ExternalLink, Puzzle } from "lucide-react";
import { BRAND, INK, RATING } from "@/lib/brand";
import { sanitizeRichText } from "@/lib/sanitize/html";
import { RationaleHoverPopover } from "@/components/report/rationale-hover";
import { EmphasizedTitle } from "@/components/report/emphasized-title";
import { collapseDuplicatedBlock, previewHtml } from "@/lib/grants/description";
import { splitTrailingParenthetical } from "@/lib/report/title";
import type { FitFactorView, ReviewFactor } from "@/lib/report/fit-factors";
import type { QaVerdictView } from "@/lib/report/qa-override";
import type { Recommendation, VerdictLead } from "@/lib/report/recommendation";
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
// passes null (or a client-safe variant) for what a client must not have. Staff-only actions
// (Generate concept proposal, the IntellEngine QA re-run) live in the `concept` slot, which
// the portal populates with the client's read-only view instead. NOTHING in the frame itself
// forks on actor, and it should stay that way: the moment this file grows an `isClient` branch,
// the two screens start drifting and the reason for sharing it is gone.

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
  qaVerdict = null,
  recommendation = null,
  verdictLead = null,
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
  // The role tag (Prime / Partner) is styled as the navy pill; focus-area tags are the light
  // neutral chip. Carried as an explicit flag rather than "tags[0] is the role" — proposed_role
  // is nullable, and an index rule painted a focus area as the role when it was absent.
  tags: { label: string; role: boolean }[];
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
  // Prose. `blocking` is bolded inside it — see the note at the top of this file. `narrative` (Step C) is
  // the client-safe single-voice paragraph QA writes on an applied demote; when present it REPLACES the
  // assembled lead/blocking/mitigation entirely (one paragraph, never stacked), else those three render.
  rationale: { lead: string | null; blocking: string | null; mitigation: string | null; narrative?: string | null };
  factors: FitFactorView;
  // The backfill control for a card with no per-factor breakdown. A client component,
  // passed in, and null on any surface that should not be able to spend a scorer call.
  // Rendered ONLY in the unscored branch — a scored card never sees it.
  scoreFactors: React.ReactNode | null;
  // The APPLIED, client-safe QA projection (migration 0088), as DATA — not a control, so it renders on
  // both this staff screen and the portal without forking on actor. `fitScore`/`factors` above already
  // reflect an applied+fresh override (resolveFit on the page); this only drives the small provenance
  // note under the fit factors — the grounded .gov sources on an applied verdict, or a "couldn't verify"
  // line. The RAW analyst voice never rides on the card (it stays in the staff-only card_intel_reviews;
  // the on-demand QA re-run control now lives in the IntellEngine box, not this screen's frame).
  // The PORTAL passes only `applied` verdicts (sources); the "couldn't verify" states are staff-passed, so
  // a client never sees QA's internal plumbing — the same "pages decide what to pass" pattern as the other slots.
  qaVerdict?: QaVerdictView | null;
  // The Send/Pass recommendation — the closing CALL of the assessment, rendered as the final line of the
  // IntellEngine Intel paragraph (NOT a box). DETERMINISTIC data (a projection of the coalesced score +
  // proposed role), not a control, so it renders on both this staff screen and the portal. A PASS is
  // staff-only — the PAGE passes null for it on the client side (`buildRecommendation(..., "client")`),
  // the same "pages decide what to pass" gate as qaVerdict. Null when there is no call to state.
  recommendation?: Recommendation | null;
  // The go/no-go VERDICT LEAD — the directional call that OPENS the IntellEngine Intel paragraph, ahead of
  // the reasoning. DETERMINISTIC data (a projection of the displayed score + any hard kill; see
  // lib/report/recommendation.ts buildVerdict), not a control, so it renders on both surfaces. A no-go is
  // STAFF-ONLY — the PAGE passes null for it on the client side (`buildVerdict(..., "client")`), the same
  // "pages decide what to pass" gate as the PASS recommendation. Null when there is no call to state.
  // (Distinct from the `verdict` STRING prop above, which is the ScoreCard's one-word fit label.)
  verdictLead?: VerdictLead | null;
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
              qaVerdict={qaVerdict}
              recommendation={recommendation}
              verdictLead={verdictLead}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-3.5">
            <ScoreCard score={fitScore} verdict={verdict} consequence={consequence} feedback={feedback} decision={decision} />
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
  tags: { label: string; role: boolean }[];
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
        {/* The role tag (Prime / Partner) is the navy pill; focus-area tags are the light
            neutral chip. Keyed on the role flag, NOT index — proposed_role is nullable, so an
            index rule painted a focus area navy when the role was absent. Conformed off the
            mock's teal category pill: teal is STAGE.approved and means one pipeline stage,
            never a decorative category colour. */}
        {tags.map((t) => (
          <span
            key={t.label}
            className={
              t.role
                ? "rounded-full bg-brand-navy px-[11px] py-1 text-[10.5px] font-bold tracking-[0.02em] text-white"
                : "rounded-full bg-brand-navy/[0.06] px-[11px] py-1 text-[10.5px] font-semibold capitalize text-brand-navy"
            }
          >
            {t.label}
          </span>
        ))}
        {agencyLine && <span className="ml-auto text-[11.5px] text-ink-subtle">{agencyLine}</span>}
      </div>

      {/* Two lines at 22px is the budget. Three pushes the meta row down and the fit-factors
          block is what gets clipped — see its note. The distinctive word is italic-orange
          (titleParts) and a trailing acronym like "(SDS)" is de-emphasised. */}
      <GrantTitle title={title} />

      <ProgrammeSummary raw={summary} />

      <AllowableUsesBlock value={allowableUses} />

      <MetaTiles meta={meta} />

      <EligibilityCallout eligibility={eligibility} />
    </section>
  );
}

// Grant title — the distinctive word italic-orange, a trailing acronym de-emphasised (grey).
function GrantTitle({ title }: { title: string }) {
  const { head, tail } = splitTrailingParenthetical(title);
  return (
    <h1 className="mt-[9px] font-serif text-[22px] font-bold leading-[1.22] tracking-[-0.01em] text-brand-navy [text-wrap:pretty]">
      <EmphasizedTitle text={head} />
      {tail && <span className="font-normal text-ink-subtle"> {tail}</span>}
    </h1>
  );
}

// The facts strip as bordered tiles. Deadline is the accent tile (navy, orange value, a faint
// orange bloom), placed LAST — the one time-critical fact. It keeps the locked danger
// treatment: an overdue deadline (tone="danger") fills red and wins over the navy accent,
// because that is the single fact that invalidates the whole page. period_of_performance can
// run long, so values clamp to two lines with the full text on hover.
function MetaTiles({ meta }: { meta: ReviewMeta[] }) {
  if (meta.length === 0) return null;
  const isDeadline = (m: ReviewMeta) => m.label.trim().toLowerCase() === "deadline";
  const ordered = [...meta.filter((m) => !isDeadline(m)), ...meta.filter(isDeadline)];
  return (
    <div className="mt-[11px] grid grid-cols-2 gap-1.5 border-t border-hairline-strong pt-[10px] sm:grid-cols-3 lg:grid-cols-5">
      {ordered.map((m) => {
        const overdue = m.tone === "danger";
        const accent = isDeadline(m) && !overdue;
        return (
          <div
            key={m.label}
            className={`relative overflow-hidden rounded-sharp border px-[12px] py-[8px] ${
              overdue || accent ? "border-transparent" : "border-edge bg-brand-cream"
            }`}
            style={overdue ? { backgroundColor: BRAND.reject } : accent ? { backgroundColor: BRAND.navy } : undefined}
          >
            {accent && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-5 -top-6 h-[70px] w-[70px] rounded-full"
                style={{ background: `radial-gradient(circle, ${BRAND.orangeGlow}, transparent 70%)` }}
              />
            )}
            {/* white/90 on the red/navy fills, not the /55–/72 the ink surfaces use: at 10px
                bold uppercase those land near 3.6:1, /90 clears AA. */}
            <p className={`relative ${EYEBROW} ${overdue ? "!text-white/90" : accent ? "!text-white/60" : ""}`}>
              {m.label}
            </p>
            <p
              className={`relative mt-1 line-clamp-2 font-serif text-[15px] font-bold tabular-nums ${
                overdue ? "text-white" : accent ? "" : "text-brand-navy"
              }`}
              style={accent ? { color: BRAND.orange } : undefined}
              title={m.value}
            >
              {m.value}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// Eligibility, folded into the grant box as a neutral-tinted callout (conformed off the mock's
// teal box — teal is STAGE.approved and must not read as decoration here). The chip is already
// neutral, not green (a keyword match against NOFO prose does not establish more than that).
// "Limits to check:" is verbatim from the NOFO — never paraphrased, since an exclusion restated
// in our words is a legal claim we did not make.
function EligibilityCallout({ eligibility }: { eligibility: EligibilityVerdict }) {
  const hasLimits = eligibility.excluded || eligibility.reasons.length > 0;
  return (
    <div className="mt-[10px] rounded-sharp border border-edge bg-brand-cream/60 px-4 py-[9px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <EligibilityChip verdict={eligibility} />
        {eligibility.matchedType && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted" title={eligibility.matchedType}>
            as {eligibility.matchedType.replace(/\.$/, "").toLowerCase()}
          </span>
        )}
        {eligibility.eligibleTypes.length > 1 && (
          <span
            className="ml-auto shrink-0 text-[11.5px] font-semibold text-ink-subtle"
            title={eligibility.eligibleTypes.join(" · ")}
          >
            All {eligibility.eligibleTypes.length} entity types
          </span>
        )}
      </div>
      {hasLimits && (
        <p className="mt-2 line-clamp-2 text-[12px] leading-[1.5] text-ink-muted">
          <strong className="font-semibold" style={{ color: BRAND.orangeDeep }}>
            Limits to check:{" "}
          </strong>
          {eligibility.excluded ?? eligibility.reasons[0]}
        </p>
      )}
    </div>
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
  const { html } = previewHtml(clean, 58);
  return (
    <div
      className="mt-2 space-y-2 text-[13px] leading-[1.55] text-ink-muted [text-wrap:pretty] [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-brand-navy"
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

  // Two lists off the one column: what funds MAY be spent on (navy checks) and what they may NOT
  // (muted bans). A row written before the two-list change has kind "allowed", so a legacy list is
  // all-allowed and renders exactly as before.
  const allowed = value.items.filter((i) => i.kind !== "not_allowed");
  const notAllowed = value.items.filter((i) => i.kind === "not_allowed");

  return (
    <div className="mt-[13px] border-t border-hairline-strong pt-3">
      {/* orange rule + orangeDeep label, matching the mock. The check icons are navy, not the
          mock's teal (STAGE.approved) — a "you may spend on this" tick is not a pipeline stage. */}
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-[3px] w-9 shrink-0 bg-brand-orange" />
        <h2 className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: BRAND.orangeDeep }}>
          Uses of funds
        </h2>
      </div>
      {value.items.length === 0 ? (
        <p className="mt-2 text-[13px] leading-[1.6] text-ink-muted">{ALLOWABLE_USES_FALLBACK}</p>
      ) : (
        <>
          {allowed.length > 0 && (
            <ul className="mt-[9px] space-y-[5px]">
              {allowed.map((item) => (
                <li
                  key={`allowed:${item.line}`}
                  className="flex items-start gap-2.5 text-[13px] leading-[1.45] text-ink-muted [text-wrap:pretty]"
                  // The verbatim NOFO span this line came from. Absent only on rows written
                  // before quotes were stored, so the attribute is conditional rather than an
                  // empty tooltip.
                  title={item.quote || undefined}
                >
                  <Check className="mt-[2px] h-3.5 w-3.5 shrink-0 text-brand-navy" aria-hidden="true" />
                  <span className="min-w-0">{item.line}</span>
                </li>
              ))}
            </ul>
          )}
          {notAllowed.length > 0 && (
            <>
              <h3 className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                Not allowed
              </h3>
              <ul className="mt-[6px] space-y-[5px]">
                {notAllowed.map((item) => (
                  <li
                    key={`not-allowed:${item.line}`}
                    className="flex items-start gap-2.5 text-[13px] leading-[1.45] text-ink-muted [text-wrap:pretty]"
                    title={item.quote || undefined}
                  >
                    <Ban className="mt-[2px] h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="min-w-0">{item.line}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
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
  qaVerdict,
  recommendation,
  verdictLead,
}: {
  rationale: { lead: string | null; blocking: string | null; mitigation: string | null; narrative?: string | null };
  factors: FitFactorView;
  scoreFactors: React.ReactNode | null;
  footnote: string;
  qaVerdict: QaVerdictView | null;
  recommendation: Recommendation | null;
  verdictLead: VerdictLead | null;
}) {
  // Step C: an applied-demote card carries a single client-safe narrative paragraph that IS the whole
  // rationale; when present it REPLACES the assembled lead/blocking/mitigation (never stacked). Else the
  // three engine-derived pieces render exactly as before.
  const narrative = rationale.narrative?.trim() || null;
  const hasProse = narrative || rationale.lead || rationale.blocking || rationale.mitigation;
  // The VERDICT LEAD opens the paragraph — the go/no-go call, ahead of the reasoning. Deterministic, pinned
  // to the displayed score (the model never authors it), so prose and score can't disagree. It leads the
  // same <p> as the reasoning; the reasoning body (the QA narrative, written NOT to restate the call) flows
  // straight on from it, matching the target voice "No-go for NWACC. This is a fossil-energy R&D grant…".
  const lead = verdictLead?.text?.trim() || null;
  // The recommendation closes the paragraph as its final line. It states the CALL only; the specific
  // reason is the prose directly above it — the bold blocking sentence (which is authoritative for BOTH a
  // factor-blocked and a calibration-driven pass), or the QA narrative. The line never derives its own
  // reason, so it can't assert a cap the score doesn't actually rest on. Left column shows whenever there
  // is a lead, prose, OR a recommendation to state.
  const showLeft = lead || hasProse || recommendation;
  return (
    <section className={`flex min-h-0 flex-1 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-[14px]">
        {/* Icon tile conformed off the mock's teal circle — teal is STAGE.approved, not chrome. */}
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06]">
          <Puzzle className="h-4 w-4 text-brand-navy" aria-hidden="true" />
        </span>
        <h2 className="font-serif text-[17px] font-bold text-brand-navy">IntellEngine Intel</h2>
        <span className="ml-auto rounded-full bg-brand-navy/[0.06] px-3 py-1 text-[11px] font-semibold text-brand-navy">
          Why this grant fits
        </span>
      </div>

      {/* THE FLEXIBLE, SCROLLABLE MIDDLE — rationale on the left, the factor table on the right.
          overflow-y-auto is the safety valve, and STILL LOAD-BEARING: this screen may not scroll
          the PAGE, but a sparse record can push the table past its budget. The unscored branch and
          any insufficient_data row keep their reason on the hover pop-out (portal, no layout cost)
          + native title + sr-only, rather than the old always-inline paragraph — the mock's compact
          table has no room for inline reasons, and the primary rationale is right here on the left.
          THE PAGE'S ONE ARGUMENT LIVES HERE: the bold blocking sentence in the prose, and — in
          the table — the weak factor's orange bar standing out against the navy strong bars. Do
          not un-bold the sentence. */}
      <div className="flex min-h-0 flex-1 gap-5 overflow-y-auto px-5 pb-2">
        {showLeft && (
          <div className="min-w-0 flex-[1.3]">
            {(lead || hasProse) && (
              <p className="text-[13px] leading-[1.65] text-ink-muted [text-wrap:pretty]">
                {/* THE VERDICT LEAD opens the paragraph — the go/no-go call, bold, ahead of the reasoning.
                    Hue is REDUNDANT (the word "No-go/Marginal/Go" carries the meaning), so the no-go orange
                    is safe under the colour-blind rule: it matches the PASS line's orangeDeep, go/marginal
                    stay navy. The reasoning that follows was written NOT to restate the call. */}
                {lead &&
                  (verdictLead!.call === "no-go" ? (
                    <strong className="font-bold" style={{ color: BRAND.orangeDeep }}>
                      {lead}{" "}
                    </strong>
                  ) : (
                    <strong className="font-bold text-brand-navy">{lead} </strong>
                  ))}
                {narrative ? (
                  // The QA client-safe narrative IS the reasoning body — one flowing paragraph after the
                  // lead, rendered in place of the three engine pieces. It does not restate the call.
                  narrative
                ) : hasProse ? (
                  <>
                    {rationale.lead && <>{rationale.lead} </>}
                    {/* The blocking sentence, in bold, in navy — the engine's own rationale string for
                        the weakest factor, not a rewrite, so the page cannot assert a cap the score does
                        not actually rest on. */}
                    {rationale.blocking && (
                      <strong className="font-semibold text-brand-navy">{rationale.blocking} </strong>
                    )}
                    {rationale.mitigation}
                  </>
                ) : null}
              </p>
            )}
            {/* The closing CALL — the final line of the paragraph, not a box. Deterministic from the
                coalesced score (see lib/report/recommendation.ts); the prose above is the argument, this
                is the verdict. A PASS is staff-only and never reaches here on the client side (the page
                passes null). */}
            {recommendation && <RecommendationLine rec={recommendation} spaced={!!(lead || hasProse)} />}
          </div>
        )}
        {showLeft && <span aria-hidden="true" className="w-px shrink-0 self-stretch bg-brand-navy/[0.08]" />}

        {/* The table is WIDER than the rationale — Design's mock puts the factor grid at
            1.65fr against the prose's 1.3fr, so the bars have room to read. */}
        <div className="min-w-0 flex-[1.65]">
          {factors.unscored ? (
            // Per-factor sub-scores shipped 2026-07-27 (migration 0038) with no backfill by
            // design; a null can only mean the card was matched before that date. scoreFactors is
            // the one control that re-scores (staff-only); when the caller passes nothing, the
            // plain statement stands.
            scoreFactors ?? (
              <p className="text-[12.5px] leading-[1.5] text-ink-muted">
                No per-factor breakdown — this card was matched before factor scoring shipped (27 Jul).
              </p>
            )
          ) : (
            <>
              {/* Header aligned to the row columns below: name 0.65fr, score 1fr. */}
              <div className="mb-2 flex items-center">
                <p className={`flex-[0.65] pl-2 ${EYEBROW} tracking-[0.12em]`}>Fit Factors</p>
                <p className={`flex-1 ${EYEBROW} tracking-[0.12em]`}>Score</p>
              </div>
              {factors.factors.map((f, i) => (
                <FactorRow key={f.key} factor={f} zebra={i % 2 === 1} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* IntellEngine QA provenance, when a verdict is in effect (migration 0088). Above the footnote so
          it reads as part of the score's provenance. Null when there is no verdict (today) — no band. */}
      {qaVerdict && <QaVerdictNote qa={qaVerdict} />}

      {/* Pinned, full-width footnote — the machine-scored / six-factors context, kept from the
          old layout so the redesign does not quietly drop it. */}
      <p className="shrink-0 border-t border-hairline-strong px-5 py-[9px] text-[11px] text-ink-subtle">{footnote}</p>
    </section>
  );
}

// The recommendation line — the assessment's closing CALL, styled as the final line of the IntellEngine
// Intel paragraph (NO box). It states the verdict the prose above argued for, and ONLY the verdict + the
// capacity — the reason lives in the prose directly above it, never restated here:
//   SEND (clean, fit 3)        → "Send — as {capacity}." (client: "Pursue — as {capacity}.")
//   SEND (conditional, fit 2)  → the "conditional" qualifier in orange, so a 2 never reads like a 3 —
//                                but REASON-AGNOSTIC: a fit-2 can be a partner-structure fit, a
//                                generic-nexus adjacency demote (unconfirmed program history), or a
//                                calibration demote, so the line NEVER names the condition (that would
//                                fabricate a fix — e.g. "get an MOU" — for a card whose real caveat is
//                                something else). The specific condition is in the prose above.
//   PASS (fit 1, STAFF-ONLY)   → "Pass." A client never sees it; the reason is the bold blocking sentence.
// Deterministic + client-safe (see lib/report/recommendation.ts): the verb is already side-chosen, and the
// only free text is the card's own proposed role — nothing fabricated.
function RecommendationLine({ rec, spaced }: { rec: Recommendation; spaced: boolean }) {
  const capacity = rec.capacity?.trim() || null;
  return (
    <p className={`text-[13px] leading-[1.6] text-ink-muted [text-wrap:pretty] ${spaced ? "mt-2.5" : ""}`}>
      <span aria-hidden="true" className="mr-1 font-semibold text-ink-subtle">
        →
      </span>
      {rec.call === "SEND" ? (
        rec.conditional ? (
          <>
            <strong className="font-bold text-brand-navy">{rec.verb}</strong>
            <strong className="font-bold" style={{ color: BRAND.orangeDeep }}>
              {" "}
              — conditional
            </strong>
            {capacity ? <> · as {capacity}.</> : <>.</>}
          </>
        ) : (
          <>
            <strong className="font-bold text-brand-navy">{rec.verb}</strong>
            {capacity ? <> — as {capacity}.</> : <>.</>}
          </>
        )
      ) : (
        <strong className="font-bold" style={{ color: BRAND.orangeDeep }}>
          {rec.verb}.
        </strong>
      )}
    </p>
  );
}

// The QA provenance note under the fit factors. On an APPLIED verdict it shows the grounded .gov sources
// QA verified the score against — client-safe (the plan's "the client sees the sources"), and the score /
// factors above already reflect QA's number. On a staff-passed unverified/failed verdict it is a plain
// "couldn't verify, showing the engine score" line; the portal hands this component only `applied`
// verdicts, so a client never sees that internal plumbing. NEVER the raw analyst note — that is staff-only
// in card_intel_reviews and is never selected into this path.
function QaVerdictNote({ qa }: { qa: QaVerdictView }) {
  if (qa.status === "applied") {
    // Only real http(s) links render — a belt-and-suspenders guard even though qa_sources is built from
    // the .gov-allowlisted fetcher, so a malformed value can never become a javascript: href.
    const links = qa.sources.filter((u) => /^https?:\/\//i.test(u));
    if (links.length === 0) return null;
    return (
      // COLLAPSED BY DEFAULT — a native <details> with no `open` attribute, so the list starts
      // closed on load (SSR-safe, no client JS). Expanded, the sources stacked down the left and
      // left the right half empty, dominating the box height; the summary keeps the provenance one
      // click away without the whitespace. `open:` rotates the chevron ▸ → ▾.
      <details className="group shrink-0 border-t border-hairline-strong px-5 py-[9px]">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1.5 ${EYEBROW} [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60`}
        >
          Verified against ({links.length} source{links.length === 1 ? "" : "s"})
          <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        </summary>
        <ul className="mt-1.5 flex flex-col gap-1">
          {links.map((url) => (
            <li key={url} className="min-w-0">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title={url}
                className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-brand-navy underline decoration-brand-navy/30 underline-offset-2 hover:decoration-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
              >
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{sourceLabel(url)}</span>
              </a>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  // unverified | failed — staff-passed only (the portal never hands these through).
  return (
    <div className="shrink-0 border-t border-hairline-strong px-5 py-[9px]">
      <p className="text-[11px] leading-[1.5] text-ink-subtle">
        IntellEngine QA could not verify this against the official source — showing the engine&rsquo;s score.
      </p>
    </div>
  );
}

// A source link's readable label: host + path, so a long .gov URL reads as its page rather than wrapping.
function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

// One factor row — the name in a left cell, then a FULL-WIDTH 3-segment bar that spans the score
// column with the rating word pinned to its right. The bar segments are flex-1 so they fill the
// column rather than hugging the edge.
//
// HUE ENCODES THE RATING, by Design's direction (2026-08-18): a bar filled ONE of three reads
// weak and its filled segment is orange; a bar filled two or three reads adequate/strong and its
// filled segments are navy ("blue"). An unscored row (zero filled) is all empty segments. The
// rating word takes the same colour. Rows carry a plain alternating grey zebra and NOTHING more —
// the earlier orange capping-row tint is gone; the weak-factor emphasis now lives in the orange
// bar itself, and the bold blocking sentence states it in prose beside the table.
//
// THE REASON RIDES THE HOVER POP-OUT for every scored row that has a rationale: a styled
// hover/focus pop-out (RationaleHoverPopover, portal-rendered so the card's fixed-height
// overflow can't clip it) plus a native `title` (no-JS / touch fallback) and an sr-only span.
// The compact table has no room for an always-inline reason, and the primary rationale sits
// right beside it in the left column, so a row points to its reason on hover instead.
function FactorRow({ factor, zebra }: { factor: ReviewFactor; zebra: boolean }) {
  const hover = !!factor.rationale;
  // Weak (one of three) → orange; two or three → navy. Zero filled has no bar colour to pick.
  const weak = factor.filled === 1;
  const barColor = weak ? BRAND.orange : BRAND.navy;
  const wordColor = weak ? BRAND.orangeDeep : factor.filled >= 2 ? BRAND.navy : INK.muted;
  return (
    <div
      title={hover ? factor.rationale ?? undefined : undefined}
      // Focusable only when it has a rationale to reveal, so Tab+focus surfaces the pop-out for
      // keyboard/motor users; rows with no pop-out stay out of the tab order.
      tabIndex={hover ? 0 : undefined}
      className={`relative flex items-center rounded-sharp py-[9px] outline-none focus-visible:ring-1 focus-visible:ring-brand-navy/40 ${
        hover ? "cursor-help" : ""
      }`}
      style={zebra ? { backgroundColor: "rgba(11,30,58,0.04)" } : undefined}
    >
      <span className="flex-[0.65] min-w-0 pr-3.5 pl-2 text-[12.5px] text-brand-navy [text-wrap:pretty]">
        {factor.label}
      </span>
      {/* Score column (1fr): the segmented bar fills it, the word pins right. */}
      <span className="flex flex-1 items-center gap-2.5 pr-2">
        <span className="flex flex-1 gap-[3px]" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-[7px] flex-1 rounded-sharp"
              style={{ backgroundColor: i < factor.filled ? barColor : RATING.empty }}
            />
          ))}
        </span>
        <span
          className="shrink-0 whitespace-nowrap text-[10.5px] font-bold tracking-[0.02em]"
          style={{ color: wordColor }}
        >
          {factor.word}
        </span>
      </span>
      <span className="sr-only">
        {factor.label}: {factor.word}
        {factor.rationale ? `. ${factor.rationale}` : ". No rationale recorded."}
      </span>
      {hover && factor.rationale && <RationaleHoverPopover rationale={factor.rationale} />}
    </div>
  );
}

function ScoreCard({
  score,
  verdict,
  consequence,
  feedback,
  decision,
}: {
  score: 1 | 2 | 3;
  verdict: string;
  consequence: string | null;
  feedback: React.ReactNode | null;
  // "Your decision" — the terminal action bar (staff release / send-alert, or the portal's
  // Pursue/Save/Pass). It lives INSIDE the fit-score box, under the feedback, so the score
  // and the call the reviewer makes on it sit together and the box grows to fit them. It renders
  // dark-themed content (no nested white card), under a thin rule.
  decision: React.ReactNode;
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
      {/* "Your decision" sits under a thin rule as a native dark-panel section (no nested white
          card) — the decision components render dark-themed content, not their own bordered
          surface. Null (a card that can't be acted on) collapses the block. */}
      {decision && <div className="mt-3 border-t border-white/[0.14] pt-3">{decision}</div>}
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
