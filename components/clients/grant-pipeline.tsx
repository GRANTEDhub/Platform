"use client";

import { useState } from "react";
import { INK, STAGE } from "@/lib/brand";
import type { Pipeline, PipelineStageKey } from "@/lib/clients/pipeline";

// The grant pipeline — the page anchor for a client, replacing the four stat tiles.
//
// WHY IT REPLACES THEM: the tiles could all read zero at once, which is exactly what a
// brand-new client saw, and a screen of zeros reads as "the platform isn't working"
// rather than "nothing has happened yet". The pipeline always has structure: five
// labelled slots that describe the funnel whether or not anything is in them. It says
// what the stages ARE even when every count is 0.
//
// The colour scale is semantic, not decorative — warm at the front of the funnel where
// work is owed, cool through the middle, terminal taupe at the end. Each colour appears
// only for its own stage. Geometry and type here are taken from the approved design
// (design/dashboard/Client Dashboard - Final.dc.html), which is the spec.

const COLOR: Record<PipelineStageKey, string> = {
  triage: STAGE.triage.color,
  client: STAGE.client.color,
  approved: STAGE.approved.color,
  pursuit: STAGE.pursuit.color,
  passed: STAGE.passed.color,
};

// COLOUR CARRIES MEANING, NOT EMPHASIS. Three cases, in order:
//   zero            muted, whatever the stage — there is nothing to look at
//   needs action    the stage's own colour, so triage pulls the eye
//   terminal        muted however large, because Passed is not an achievement to
//                   celebrate or a task to do; it is just the end of the funnel
// Everything else is ink: a live, positive stage that needs no prompting.
function countColor(count: number, needsAction: boolean, terminal: boolean): string {
  if (count === 0) return INK.subtle;
  if (needsAction) return COLOR.triage;
  if (terminal) return INK.subtle;
  return INK.DEFAULT;
}

export function GrantPipeline({
  pipeline,
  // Nearest real submission_deadline across this client's tracked grants, pre-formatted
  // by the caller (which owns the timezone). The design puts "triage window closes
  // {date}" here; there is no triage-window field in the schema and a fabricated date
  // must never ship, so the slot carries a deadline we can actually stand behind and
  // says which one it is. Null when the client has no dated grants — the clause drops
  // rather than rendering an em dash.
  nextDeadlineLabel,
}: {
  pipeline: Pipeline;
  nextDeadlineLabel?: string | null;
}) {
  const [hovered, setHovered] = useState<PipelineStageKey | null>(null);
  const { stages, total } = pipeline;

  return (
    <section className="rounded-2xl bg-white px-[22px] py-[17px] shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-base font-bold text-brand-navy">Grant pipeline</h2>
        <p className="text-[12.5px] text-ink-subtle">
          <span className="font-medium text-ink-muted">{total}</span>{" "}
          {total === 1 ? "opportunity" : "opportunities"} tracked
          {nextDeadlineLabel && (
            <>
              {" · next deadline "}
              <span className="font-medium text-ink-muted">{nextDeadlineLabel}</span>
            </>
          )}
        </p>
      </div>

      {/* Segmented bar. Each segment is proportional to its count, but a stage with
          zero collapses to a hairline rather than disappearing — the bar has to keep
          reading as five slots, or the funnel's shape changes every time a count hits
          zero. flex-grow is CSS-transitioned so a refresh animates rather than jumping;
          it is deliberately NOT animated from zero on mount, which would be a loading
          bar for data that is already here. */}
      <div className="mt-[13px] flex gap-[3px]" aria-hidden="true">
        {stages.map((s) => (
          <div
            key={s.key}
            className="h-[11px] rounded-full transition-[flex-grow,opacity] duration-[420ms] ease-entrance"
            style={{
              flexGrow: s.count > 0 ? s.count : 0.001,
              flexBasis: 0,
              backgroundColor: COLOR[s.key],
              opacity: hovered === null || hovered === s.key ? 1 : 0.55,
            }}
          />
        ))}
      </div>

      {/* Five equal columns, divided by hairlines. NOT links: see the note in
          lib/clients/pipeline.ts — there is no per-stage filtered destination yet, so
          there is deliberately no cursor or hover-background affordance either. The
          only hover response is the bar segment lifting, which highlights rather than
          promising navigation. Two columns per row below `sm`, where five would crush. */}
      <div className="mt-[14px] grid grid-cols-2 gap-y-4 sm:grid-cols-5 sm:gap-y-0">
        {stages.map((s, i) => (
          <div
            key={s.key}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
            className={i > 0 ? "sm:border-l sm:border-hairline sm:pl-[18px]" : undefined}
          >
            <div className="flex items-center gap-[7px]">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: COLOR[s.key] }}
              />
              <span className="text-xs font-semibold text-ink-muted">{s.label}</span>
            </div>
            <p
              className="ml-[15px] mt-1.5 text-2xl font-semibold leading-none tabular-nums"
              style={{ color: countColor(s.count, s.needsAction, s.terminal) }}
            >
              {s.count}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
