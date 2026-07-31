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
// the client portal. "console" is the approved design — and it is the ONE surface in the
// product allowed a gradient and a glow, because it is the one that represents the AI
// doing work. Everywhere else that treatment would be decoration.

export interface DashDraft {
  id: string;
  title: string;
  status: IntellEngineDraftStatus;
}

export function ClientDraftProgress({
  drafts,
  intellEngineHref,
  emptyNote,
  variant = "portal",
}: {
  // Most-recently-updated first (the caller already orders by updated_at, which is
  // what the hub sorts by too). The first is the one whose progress is shown.
  drafts: DashDraft[];
  intellEngineHref: string;
  emptyNote: string;
  variant?: "console" | "portal";
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(lead.status) : null;

  if (variant === "console") {
    return <ConsoleDraftPanel drafts={drafts} intellEngineHref={intellEngineHref} />;
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
// The gradient plus a soft orange bloom top-right, clipped by overflow-hidden. This is
// the only place in the product where gradient and glow are allowed; the page background
// is deliberately flat everywhere else (a texture behind flat white cards made them read
// as holes, which is what the refresh removed).
//
// NO DRAFTS keeps the panel and the whole treatment, replacing the progress block with
// one line and promoting "New draft" to the white primary. The panel disappearing would
// change the page's shape, and this is half of a side-by-side pair — its absence would
// leave the Grant Report card stretched across the full column.
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-navy";

function ConsoleDraftPanel({
  drafts,
  intellEngineHref,
}: {
  drafts: DashDraft[];
  intellEngineHref: string;
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(lead.status) : null;

  return (
    <section
      className="relative flex flex-col overflow-hidden rounded-2xl px-5 pb-[18px] pt-[17px] text-white"
      style={{ backgroundImage: `linear-gradient(145deg, ${BRAND.navy} 0%, ${BRAND.navyHover} 100%)` }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-[70px] h-[210px] w-[210px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(228,118,31,0.32), transparent 70%)" }}
      />
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

        <div className="mt-3.5 border-t border-white/[0.14] pt-[13px]">
          {!lead || !progress ? (
            <>
              <p className="text-[12.5px] leading-[1.5] text-white/[0.65]">
                No drafts yet. Start from an approved match.
              </p>
              <div className="mt-3.5">
                <Link
                  href={intellEngineHref}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-pill bg-white px-3.5 text-[12.5px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 ${FOCUS}`}
                >
                  New draft
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
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
