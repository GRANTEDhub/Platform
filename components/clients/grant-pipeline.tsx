"use client";

import { useState } from "react";
import { STAGE } from "@/lib/brand";
import type { Pipeline, PipelineStageKey } from "@/lib/clients/pipeline";

// The grant pipeline — the page anchor for a client, replacing the four stat tiles.
//
// WHY IT REPLACES THEM: the tiles could all read zero at once, which is exactly what a
// brand-new client saw, and a screen of zeros reads as "the platform isn't working"
// rather than "nothing has happened yet". The pipeline always has structure: four
// labelled slots that describe the funnel whether or not anything is in them. It says
// what the stages ARE even when every count is 0.
//
// The colour scale is semantic, not decorative — warm at the front of the funnel where
// work is owed, cool at the back. Each colour appears only for its own stage.

const COLOR: Record<PipelineStageKey, string> = {
  review: STAGE.triage.color,
  alert: STAGE.client.color,
  interested: STAGE.approved.color,
  pursuit: STAGE.pursuit.color,
};

export function GrantPipeline({ pipeline }: { pipeline: Pipeline }) {
  const [hovered, setHovered] = useState<PipelineStageKey | null>(null);
  const { stages, tracked, passed } = pipeline;

  return (
    <section className="rounded-2xl bg-white shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-3 pt-5">
        <h2 className="font-serif text-base font-bold text-brand-navy">Grant pipeline</h2>
        {/* Real counts only. The design had "triage window closes {date}" here; there
            is no triage-window concept in the system, so this reports what we can
            actually stand behind — and carries the passed count, which is deliberately
            not a bar segment. */}
        <p className="text-[12.5px] text-ink-subtle">
          <span className="font-medium text-ink-muted">{tracked}</span>{" "}
          {tracked === 1 ? "opportunity" : "opportunities"} tracked
          {passed > 0 && (
            <>
              {" · "}
              <span className="font-medium text-ink-muted">{passed}</span> passed
            </>
          )}
        </p>
      </div>

      {/* Segmented bar. Each segment is proportional to its count, but a stage with
          zero collapses to a hairline rather than disappearing — the bar has to keep
          reading as four slots, or the funnel's shape changes every time a count hits
          zero. flex-grow is CSS-transitioned so a refresh animates rather than jumping;
          it is deliberately NOT animated from zero on mount, which would be a loading
          bar for data that is already here. */}
      <div className="flex gap-[3px] px-6" aria-hidden="true">
        {stages.map((s) => (
          <div
            key={s.key}
            className="h-[11px] rounded-full transition-[flex-grow,opacity] duration-[420ms] ease-entrance"
            style={{
              flexGrow: s.count > 0 ? s.count : 0.001,
              flexBasis: 0,
              backgroundColor: COLOR[s.key],
              opacity: hovered === null ? 1 : hovered === s.key ? 1 : 0.55,
            }}
          />
        ))}
      </div>

      {/* Four equal columns. Not links: see the note in lib/clients/pipeline.ts —
          there is no per-stage filtered destination to send them to yet. */}
      <div className="mt-1 grid grid-cols-2 sm:grid-cols-4">
        {stages.map((s, i) => (
          <div
            key={s.key}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
            className={`px-6 py-4 ${i > 0 ? "sm:border-l sm:border-hairline" : ""}`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: COLOR[s.key] }}
              />
              <span className="text-xs font-semibold text-ink-muted">{s.label}</span>
            </div>
            {/* Colour carries meaning, not emphasis: the stage colour appears only when
                the stage is BOTH non-empty and waiting on us. A zero is always muted —
                there is nothing to draw the eye to. */}
            <p
              className="mt-1.5 pl-4 text-2xl font-semibold leading-none tabular-nums"
              style={{
                color: s.count === 0 ? STAGE.passed.color : s.needsAction ? COLOR[s.key] : undefined,
              }}
            >
              <span className={s.count > 0 && !s.needsAction ? "text-ink" : undefined}>{s.count}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
