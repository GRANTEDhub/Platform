import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BRAND, STAGE, STAGE_ON_INK } from "@/lib/brand";
import type { BookRollup } from "@/lib/clients/dashboard-summary";

// The client masthead — identity, actions, and the whole pipeline, on one band of ink.
//
// IT REPLACES TWO THINGS: the white identity strip (ClientContextBar) and the pipeline
// card that sat under it. The design's argument is that a client's funnel is not a card
// on the page, it IS the summary of the page, so it belongs in the chrome rather than
// competing with the cards below for the reader's first look. Collapsing the two also
// buys back roughly 90px, which is most of what makes 1440×900 fit without scrolling.
//
// THE BAR IS WEIGHTED BY COUNT, NOT MONEY. The approved mockup weights its segments by
// dollars — its flex values are the award figures. Money here is an estimate of an
// estimate (see lib/clients/dashboard-summary.ts) and the counts printed directly beneath
// the bar are exact, so a money-weighted bar sitting under exact counts invites "why
// don't these match" from every reader forever. Counts also make the drain-the-colour
// behaviour literal: clear the triage queue and the orange shrinks by exactly what you
// cleared.
//
// COLOUR IS SIGNAL, NOT CATEGORY — orange for what is owed, a neutral ramp for everything
// past it. See STAGE_ON_INK in lib/brand.ts for why the stage palette is deliberately not
// used here, and for the one collision the mockup leaves unresolved.

export function ClientMasthead({
  name,
  meta,
  statusLabel,
  book,
  assessedLabel,
  nextDeadlineLabel,
  backHref,
  backLabel,
  actions,
}: {
  name: string;
  // Already-joined descriptor (org type · city, state · client since). Joined by the
  // caller because only it knows which facts exist for this record.
  meta: string | null;
  statusLabel: string;
  book: BookRollup;
  // What the right-hand figure is called. Passed in rather than hardcoded so the caller
  // can say "assessed" only when there is something to assess.
  assessedLabel: string;
  // Nearest REAL deadline, pre-formatted. The design's line here reads "triage window
  // closes {date}"; no triage-window field exists and a fabricated date must never ship
  // on a surface staff quote to a client, so the slot carries a deadline we can stand
  // behind and names it. Null drops the clause entirely.
  nextDeadlineLabel: string | null;
  backHref: string;
  backLabel: string;
  actions?: React.ReactNode;
}) {
  const segments = book.stages.filter((s) => s.count > 0);

  return (
    <div className="relative z-[1] shrink-0 bg-brand-navy px-[34px] pb-3.5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-[9px] pt-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-[9px]">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-md text-[11.5px] font-medium text-white/[0.55] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-navy"
            >
              <ArrowLeft className="h-[13px] w-[13px]" aria-hidden="true" />
              {backLabel}
            </Link>
            <span aria-hidden="true" className="h-3 w-px bg-white/20" />
            <span
              className="rounded-full px-[9px] py-0.5 text-[10.5px] font-semibold capitalize"
              style={{ backgroundColor: "rgba(74,222,128,0.15)", color: BRAND.successOnDark }}
            >
              {statusLabel}
            </span>
          </div>
          <ClientName name={name} />
          {meta && (
            <p className="mt-[9px] truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
              {meta}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {nextDeadlineLabel && (
            <span className="text-[11.5px] text-white/[0.62]">
              Next deadline <span className="font-semibold text-brand-orange">{nextDeadlineLabel}</span>
            </span>
          )}
          {actions}
        </div>
      </div>

      <div aria-hidden="true" className="h-[2px] bg-brand-orange" />
      <div aria-hidden="true" className="mt-[3px] h-px bg-white/[0.22]" />

      <div className="pt-[11px]">
        {segments.length > 0 && (
          <div aria-hidden="true" className="flex h-[9px] gap-[2px]">
            {segments.map((s) => (
              <div key={s.key} style={{ flexGrow: s.count, flexBasis: 0, backgroundColor: STAGE_ON_INK[s.key] }} />
            ))}
          </div>
        )}
        <div className="mt-[11px] flex flex-wrap items-start">
          {book.stages.map((s, i) => (
            <div
              key={s.key}
              className={i === 0 ? "min-w-[128px] flex-1 pr-[18px]" : "min-w-[128px] flex-1 border-l border-white/[0.14] px-[18px]"}
            >
              <div className="flex items-center gap-[7px]">
                <span
                  aria-hidden="true"
                  className="h-[7px] w-[7px] shrink-0"
                  style={{ backgroundColor: STAGE_ON_INK[s.key] }}
                />
                <span className="text-[9.5px] font-bold uppercase tracking-[0.13em] text-white/[0.58]">{s.label}</span>
              </div>
              {/* A zero-count stage is muted but never blank, and its money is a dash
                  rather than $0 — "we do not know" and "it is worth nothing" are
                  different claims and only one of them is true. */}
              <p
                className="mt-[7px] font-serif text-[24px] font-bold leading-[0.85] tabular-nums"
                style={{ color: figureColor(s.key, s.count) }}
              >
                {s.count}
                <span className="font-sans text-[11.5px] font-medium text-white/50">
                  {"  "}
                  {s.money ?? "—"}
                </span>
              </p>
            </div>
          ))}
          <div className="min-w-[150px] shrink-0 border-l border-white/[0.14] pl-[18px]">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.13em] text-white/[0.58]">
              {assessedLabel}
            </span>
            <p
              className="mt-[7px] font-serif text-[24px] font-bold leading-[0.85] tabular-nums"
              style={{ color: STAGE.approved.onDark }}
            >
              {book.assessedPct}
              <span className="text-[14px] text-white/[0.55]">%</span>
            </p>
          </div>
        </div>

        {/* One marker for the whole row rather than an "est." on every cell. Award
            figures are program-level ranges, not this client's expected receipts, and the
            count of grants carrying no figure at all is part of reading the number
            honestly — a $31M pipeline with eight unpriced grants is a different fact from
            a $31M pipeline with none. */}
        {(book.hasEstimates || book.unpriced > 0) && (
          <p className="mt-[9px] text-[10px] text-white/40">
            Dollar figures are estimated award ceilings, not expected receipts
            {book.unpriced > 0 && ` · ${book.unpriced} ${book.unpriced === 1 ? "grant carries" : "grants carry"} no published figure`}
          </p>
        )}
      </div>
    </div>
  );
}

// Zero mutes; triage is the only stage that gets colour; passed sits between the two
// because it is real history but nothing to act on.
function figureColor(key: string, count: number): string {
  if (count === 0) return "rgba(255,255,255,0.45)";
  if (key === "triage") return BRAND.orange;
  if (key === "passed") return "rgba(255,255,255,0.72)";
  return "#FFFFFF";
}

// 30px is the drawn size and it overruns the masthead at around thirty characters —
// "Boston Mountain Rural Health Partnership" is forty. Stepping down beats wrapping:
// a second line pushes the metadata down and costs height the page does not have at
// 900px. Past the step it truncates with the full name on hover.
function ClientName({ name }: { name: string }) {
  const size = name.length > 44 ? "text-[20px]" : name.length > 30 ? "text-[24px]" : "text-[30px]";
  return (
    <h1
      title={name}
      className={`mt-2 truncate font-serif font-bold leading-none tracking-[-0.015em] text-white ${size}`}
    >
      {name}
    </h1>
  );
}
