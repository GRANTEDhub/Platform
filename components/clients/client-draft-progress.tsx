import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { draftProgress } from "@/lib/intellengine/drafts";
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

export interface DashDraft {
  id: string;
  title: string;
  status: IntellEngineDraftStatus;
}

export function ClientDraftProgress({
  drafts,
  intellEngineHref,
  emptyNote,
}: {
  // Most-recently-updated first (the caller already orders by updated_at, which is
  // what the hub sorts by too). The first is the one whose progress is shown.
  drafts: DashDraft[];
  intellEngineHref: string;
  emptyNote: string;
}) {
  const lead = drafts[0];
  const progress = lead ? draftProgress(lead.status) : null;

  return (
    <Card className="p-6 shadow-grounded sm:p-7">
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
