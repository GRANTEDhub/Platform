import Link from "next/link";
import { ArrowRight, Check, CircleDashed, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { draftProgress } from "@/lib/intellengine/drafts";
import { BRAND } from "@/lib/brand";
import type { IntellEngineDraftStatus } from "@/types/database";

// The IntellEngine card — the client's proposals in flight, with the furthest one's
// progress on the dashboard instead of behind a shortcut tile.
//
// The percentage and the checklist are DERIVED from the draft's status ladder
// (lib/intellengine/drafts.ts draftProgress) — there is no stored progress field, so
// there is nothing that can drift out of step with the status the hub shows. It is
// deliberately labelled as step progress, not content progress: reaching the builder
// is 75% of the FLOW, which is not a claim about how much narrative is written, and
// the caption says so rather than letting a client read it as three-quarters drafted.
//
// TWO VARIANTS, as with the Grant Report card: this renders in the staff console and in
// the client portal. "console" is the approved design; "portal" is what the portal has
// always shipped.

export interface DashDraft {
  id: string;
  title: string;
  status: IntellEngineDraftStatus;
}

// What the console panel offers when there is no draft in flight: the approved match that
// should be scoped next. See the note on ConsoleDraftPanel for why the empty state
// recommends rather than waits.
export interface DraftCandidate {
  cardId: string;
  title: string;
  // "HRSA · $900K · approved, never started" — joined by the caller, which owns the
  // award formatting and its estimate marker.
  meta: string;
  // One sentence on why this one. Rendered in italic serif, so it must read as a
  // sentence, not a label.
  rationale: string;
  href: string;
}

export function ClientDraftProgress({
  drafts,
  intellEngineHref,
  emptyNote,
  candidate,
  variant = "portal",
}: {
  // Most-recently-updated first (the caller already orders by updated_at, which is
  // what the hub sorts by too). The first is the one whose progress is shown.
  drafts: DashDraft[];
  intellEngineHref: string;
  emptyNote: string;
  // Console only. Null when there is no approved match to point at, which is a real
  // state and gets its own line rather than an invented recommendation.
  candidate?: DraftCandidate | null;
  variant?: "console" | "portal";
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(lead.status) : null;

  if (variant === "console") {
    return (
      <ConsoleDraftPanel drafts={drafts} intellEngineHref={intellEngineHref} candidate={candidate ?? null} />
    );
  }

  return (
    <Card className="p-6 shadow-card sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-[20px] font-semibold text-brand-navy">IntellEngine</h2>
        {drafts.length > 1 && (
          <p className="text-[12.5px] text-ink-subtle">
            <span className="font-medium text-ink-muted">{drafts.length}</span> proposals in flight
          </p>
        )}
      </div>

      {!lead || !progress ? (
        <p className="mt-4 text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        <>
          <div className="mt-4 flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-medium text-brand-navy">{lead.title}</p>
            <span className="shrink-0 text-[13px] font-semibold text-brand-navy">{progress.percent}%</span>
          </div>

          {/* Track + fill. aria-hidden because the checklist below states the same
              progress in text, and a redundant progressbar role would read it twice. */}
          <div aria-hidden="true" className="mt-2 h-[6px] overflow-hidden rounded-full bg-brand-navy/[0.08]">
            <div
              className="h-full rounded-full bg-brand-orange transition-[width] duration-[420ms] ease-entrance"
              style={{ width: `${progress.percent}%` }}
            />
          </div>

          <p className="mt-1.5 text-[11.5px] text-ink-subtle">
            Step {progress.step} of {progress.total} in the drafting flow
          </p>

          <ul className="mt-4 space-y-1.5">
            {progress.steps.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-[12.5px]">
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                    s.done ? "bg-brand-orange text-white" : "border border-hairline-strong bg-white"
                  }`}
                >
                  {s.done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                <span className={s.done ? "font-medium text-brand-navy" : "text-ink-subtle"}>{s.label}</span>
                <span className="sr-only">{s.done ? " — done" : " — not started"}</span>
              </li>
            ))}
          </ul>

          <Link
            href={intellEngineHref}
            className="mt-4 inline-flex items-center gap-1 rounded-md text-[12.5px] font-semibold text-brand-orange transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
          >
            {drafts.length > 1 ? "Open IntellEngine" : "Resume this proposal"}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      )}
    </Card>
  );
}

// ── Console variant — the approved design ───────────────────────────────────
//
// FLAT INK, and the gradient-plus-glow is gone. It was the one place in the product
// allowed that treatment, on the argument that this is the surface where the AI does
// work. The ink direction retires it: cards are drawn planes, not lifted paper, and a
// glowing gradient panel next to five squared flat ones now reads as the odd one out
// rather than as emphasis. The panel is still the only DARK card on the page, which is
// the emphasis it actually needed.
//
// NO DRAFTS RECOMMENDS RATHER THAN WAITS, and that is the panel's whole argument in its
// most common state. "No drafts yet. Start from an approved match." plus a New draft
// button is a tool sitting idle: correct, useless, and a large dead box in a 1fr column
// beside a Grant Report card carrying real rows. Naming the approved match that should be
// scoped next — with its agency, its money, and one sentence on why it is that one —
// makes the same box a colleague pointing at something.
//
// It never invents the recommendation. With no approved match to point at there is
// nothing to recommend, and the panel says that in one line instead.
//
// HEIGHT IS A CONSTRAINT, NOT A PREFERENCE. This shares a 1fr row with a card of about
// 330px of real content, so the empty state has to fit the same box or its buttons clip
// out of existence. Do not add explanatory copy to it.
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-navy";

function ConsoleDraftPanel({
  drafts,
  intellEngineHref,
  candidate,
}: {
  drafts: DashDraft[];
  intellEngineHref: string;
  candidate: DraftCandidate | null;
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(lead.status) : null;

  return (
    <section className="relative flex flex-col overflow-hidden rounded-sharp bg-brand-navy px-5 pb-[18px] pt-[17px] text-white">
      <div className="relative flex flex-1 flex-col">
        <div className="flex items-center gap-[7px]">
          <Sparkles className="h-3.5 w-3.5 text-brand-orange" aria-hidden="true" />
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-brand-orange">
            AI proposal developer
          </p>
        </div>
        <h2 className="mt-[7px] font-serif text-[18px] font-bold">IntellEngine</h2>
        <p className="mt-[5px] text-[12.5px] leading-[1.5] text-white/[0.65]">
          Turns an approved match into a scoped draft — narrative, budget frame, consortium.
        </p>

        <div className="mt-3.5 flex flex-1 flex-col border-t border-white/[0.14] pt-[13px]">
          {!lead || !progress ? (
            <>
              <div className="flex items-center justify-between gap-2.5">
                <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-white/[0.5]">
                  {candidate ? "Ready to scope" : "Nothing to scope yet"}
                </p>
                <span className="shrink-0 text-[11.5px] text-white/[0.58]">No drafts open</span>
              </div>

              {candidate ? (
                <>
                  {/* A 2px orange rule, not a card inside a card. The recommendation is
                      one thing being pointed at, and a bordered box around it would make
                      it look like a list of one. */}
                  <div className="mt-[13px] border-l-2 pl-[11px]" style={{ borderColor: BRAND.orange }}>
                    <p className="truncate text-[13px] font-semibold">{candidate.title}</p>
                    <p className="mt-1 truncate text-[11.5px] text-white/[0.62]">{candidate.meta}</p>
                    {/* Italic serif, same voice as the ambient note on the attention
                        card: this is a judgement, not a field. */}
                    <p className="mt-[7px] font-serif text-[12.5px] italic leading-[1.5] text-white/80 [text-wrap:pretty]">
                      {candidate.rationale}
                    </p>
                  </div>
                  <div className="mt-auto flex items-center gap-2 pt-[13px]">
                    <Link
                      href={candidate.href}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-sharp bg-white px-3.5 text-[12.5px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 ${FOCUS}`}
                    >
                      Scope this one
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                    <Link
                      href={intellEngineHref}
                      className={`inline-flex h-8 items-center rounded-sharp border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors duration-[120ms] hover:border-white/40 ${FOCUS}`}
                    >
                      Pick another
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-[13px] text-[12.5px] leading-[1.5] text-white/[0.65]">
                    Approve a match and IntellEngine can scope it.
                  </p>
                  <div className="mt-auto pt-[13px]">
                    <Link
                      href={intellEngineHref}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-sharp border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors duration-[120ms] hover:border-white/40 ${FOCUS}`}
                    >
                      Open IntellEngine
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-white/[0.42]">
                Draft in progress
              </p>
              <div className="mt-[9px] flex items-center justify-between gap-2.5">
                <p className="min-w-0 truncate text-[12.5px] font-medium">{lead.title}</p>
                <span className="shrink-0 text-[12px] font-semibold tabular-nums text-brand-orange">
                  {progress.percent}%
                </span>
              </div>

              {/* aria-hidden: the checklist below says the same thing in text, and a
                  progressbar role would have it read twice. */}
              <div aria-hidden="true" className="mt-[7px] h-[5px] overflow-hidden rounded-full bg-white/[0.14]">
                <div
                  className="h-full rounded-full bg-brand-orange transition-[width] duration-[420ms] ease-entrance"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              <ul className="mt-2.5 flex flex-col gap-[5px]">
                {progress.steps.map((s) => (
                  <li
                    key={s.key}
                    className={`flex items-center gap-[7px] text-[11.5px] ${
                      s.done ? "text-white/[0.62]" : "text-white/40"
                    }`}
                  >
                    {s.done ? (
                      <Check
                        className="h-[13px] w-[13px] shrink-0"
                        strokeWidth={3}
                        style={{ color: BRAND.successOnDark }}
                        aria-hidden="true"
                      />
                    ) : (
                      <CircleDashed className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
                    )}
                    {s.label}
                    <span className="sr-only">{s.done ? " — done" : " — not started"}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-2.5 text-[11px] text-white/40">
                Step {progress.step} of {progress.total} in the drafting flow
              </p>

              <div className="mt-3.5 flex items-center gap-2">
                <Link
                  href={intellEngineHref}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-pill bg-white px-3.5 text-[12.5px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 ${FOCUS}`}
                >
                  Resume draft
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
                <Link
                  href={intellEngineHref}
                  className={`inline-flex h-8 items-center rounded-pill border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors duration-[120ms] hover:border-white/40 ${FOCUS}`}
                >
                  New draft
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
