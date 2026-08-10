import Link from "next/link";
import { ArrowRight, Check, CircleDashed, Minus, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { draftProgress } from "@/lib/intellengine/drafts";
import { readDraftContent } from "@/lib/intellengine/content";
import { BRAND } from "@/lib/brand";

// The IntellEngine card — the client's proposals in flight, with the furthest one's
// progress on the dashboard instead of behind a shortcut tile.
//
// PROGRESS COMES FROM THE DRAFT'S CONTENT, NOT ITS STATUS (0074). It used to read the
// status ladder, which records the furthest screen OPENED — so a draft whose three
// screens had been clicked through while empty rendered here at 100% with every box
// checked, and the caption's "step progress, not content progress" hedge was carrying
// far more weight than a caption can. Now a box is checked when the content for that
// step is actually present, which is what a reader takes a checked box to mean.
//
// A rung can also be UNASSESSABLE (compliance, until the document layer lands): it shows
// a dash rather than a check or an empty circle, and it is excluded from the percentage
// so a draft is not marked down for a check the product cannot run yet.
//
// TWO VARIANTS, as with the Grant Report card: this renders in the staff console and in
// the client portal. "console" is the approved design; "portal" is what the portal has
// always shipped.

export interface DashDraft {
  id: string;
  title: string;
  // Raw jsonb from intellengine_drafts.content; parsed here through readDraftContent so
  // callers never have to know the shape (and an unapplied 0074 reads as empty).
  content: unknown;
}

// One grant the panel is pointing at.
export interface DraftPick {
  title: string;
  // "HRSA · $900K · approved, never started" — joined by the caller, which owns the
  // award formatting and its estimate marker.
  meta: string;
  // One sentence on why this one. Rendered in italic serif, so it must read as a
  // sentence, not a label, and every clause of it must be a fact the caller actually has.
  rationale: string;
  href: string;
}

// What the console panel says when no draft is in flight. THE PANEL IS NEVER EMPTY: it
// always has something to point at or a specific reason it cannot.
//
//   ready    approved matches exist and none is drafted — scope this one
//   waiting  nothing approved yet, so the blocker is upstream. Names it, and still shows
//            the closest candidate so the reader knows what approving would get them.
//
// Null means neither applies (nothing matched at all), and the panel says so in a line.
export type DraftNext =
  | { kind: "ready"; pick: DraftPick }
  | { kind: "waiting"; unassessed: number; reviewHref: string; pick: DraftPick | null };

export function ClientDraftProgress({
  drafts,
  intellEngineHref,
  emptyNote,
  next,
  variant = "portal",
}: {
  // Most-recently-updated first (the caller already orders by updated_at, which is
  // what the hub sorts by too). The first is the one whose progress is shown.
  drafts: DashDraft[];
  intellEngineHref: string;
  emptyNote: string;
  // Console only. See DraftNext.
  next?: DraftNext | null;
  variant?: "console" | "portal";
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(readDraftContent(lead.content)) : null;

  if (variant === "console") {
    return (
      <ConsoleDraftPanel drafts={drafts} intellEngineHref={intellEngineHref} next={next ?? null} />
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

          {/* Counts CAPTURED steps against ASSESSABLE ones, not position in the flow.
              The old "Step 3 of 4" was true of navigation and false of the work. */}
          <p className="mt-1.5 text-[11.5px] text-ink-subtle">
            {progress.done} of {progress.assessable} steps captured
          </p>

          <ul className="mt-4 space-y-1.5">
            {progress.steps.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-[12.5px]">
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                    s.state === "done" ? "bg-brand-orangeFill text-white" : "border border-hairline-strong bg-white"
                  }`}
                >
                  {s.state === "done" && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  {s.state === "unknown" && <Minus className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={3} />}
                </span>
                <span className={s.state === "done" ? "font-medium text-brand-navy" : "text-ink-subtle"}>
                  {s.label}
                </span>
                <span className="sr-only">
                  {s.state === "done" ? " — done" : s.state === "unknown" ? " — not yet checkable" : " — not started"}
                </span>
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
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome";
const PRIMARY = `inline-flex h-8 items-center gap-1.5 rounded-sharp bg-white px-3.5 text-[12.5px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 ${FOCUS}`;
const SECONDARY = `inline-flex h-8 items-center rounded-sharp border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors duration-[120ms] hover:border-white/40 ${FOCUS}`;

function ConsoleDraftPanel({
  drafts,
  intellEngineHref,
  next,
}: {
  drafts: DashDraft[];
  intellEngineHref: string;
  next: DraftNext | null;
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(readDraftContent(lead.content)) : null;

  return (
    <section className="relative flex flex-col overflow-hidden rounded-sharp bg-brand-chrome px-5 pb-[18px] pt-[17px] text-white">
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
              {/* The strip names the STATE, and when the panel is blocked it names the
                  blocker. "No drafts open" on its own explains nothing; "Waiting on an
                  approval · 8 unassessed" says where the work actually is. */}
              <div className="flex items-center justify-between gap-2.5">
                <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-white/[0.5]">
                  {next?.kind === "ready"
                    ? "Ready to scope"
                    : next?.kind === "waiting"
                      ? `Waiting on an approval${next.unassessed > 0 ? ` · ${next.unassessed} unassessed` : ""}`
                      : "Nothing to scope yet"}
                </p>
                <span className="shrink-0 text-[11.5px] text-white/[0.58]">No drafts open</span>
              </div>

              {next?.pick ? (
                <>
                  {/* A 2px orange rule, not a card inside a card. This is one thing being
                      pointed at, and a bordered box would make it look like a list of
                      one. Nothing else goes in here — the card has to fit the same box as
                      a Grant Report carrying three real rows, and every previous attempt
                      to add a readiness list pushed the buttons out of existence. */}
                  <div className="mt-[13px] border-l-2 pl-[11px]" style={{ borderColor: BRAND.orange }}>
                    <p className="truncate text-[13px] font-semibold">{next.pick.title}</p>
                    <p className="mt-1 truncate text-[11.5px] text-white/[0.62]">{next.pick.meta}</p>
                    {/* Italic serif, same voice as the ambient note on the attention card:
                        this is a judgement, not a field. */}
                    <p className="mt-[7px] font-serif text-[12.5px] italic leading-[1.5] text-white/80 [text-wrap:pretty]">
                      {next.pick.rationale}
                    </p>
                  </div>
                  <div className="mt-auto flex items-center gap-2 pt-[13px]">
                    {next.kind === "ready" ? (
                      <>
                        <Link href={next.pick.href} className={PRIMARY}>
                          Scope this one
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                        <Link href={intellEngineHref} className={SECONDARY}>
                          Pick another
                        </Link>
                      </>
                    ) : (
                      <>
                        {/* The primary routes to what UNBLOCKS the panel, not to the
                            panel's own tool. Nothing here can start until something is
                            approved, so offering a draft button would be the dead
                            affordance this card exists to avoid. */}
                        <Link href={next.reviewHref} className={PRIMARY}>
                          {next.unassessed > 0 ? `Review the ${next.unassessed}` : "Review matches"}
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                        <Link href={intellEngineHref} className={SECONDARY}>
                          Open IntellEngine
                        </Link>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-[13px] text-[12.5px] leading-[1.5] text-white/[0.65]">
                    Approve a match and IntellEngine can scope it.
                  </p>
                  <div className="mt-auto pt-[13px]">
                    <Link href={intellEngineHref} className={SECONDARY}>
                      Open IntellEngine
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
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
                      s.state === "done" ? "text-white/[0.62]" : "text-white/40"
                    }`}
                  >
                    {s.state === "done" ? (
                      <Check
                        className="h-[13px] w-[13px] shrink-0"
                        strokeWidth={3}
                        style={{ color: BRAND.successOnDark }}
                        aria-hidden="true"
                      />
                    ) : s.state === "unknown" ? (
                      <Minus className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
                    ) : (
                      <CircleDashed className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
                    )}
                    {s.label}
                    <span className="sr-only">
                      {s.state === "done" ? " — done" : s.state === "unknown" ? " — not yet checkable" : " — not started"}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-2.5 text-[11px] text-white/40">
                {progress.done} of {progress.assessable} steps captured
              </p>

              <div className="mt-3.5 flex items-center gap-2">
                <Link
                  href={intellEngineHref}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-sharp bg-white px-3.5 text-[12.5px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 ${FOCUS}`}
                >
                  Resume draft
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
                <Link
                  href={intellEngineHref}
                  className={`inline-flex h-8 items-center rounded-sharp border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors duration-[120ms] hover:border-white/40 ${FOCUS}`}
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
