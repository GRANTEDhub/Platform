"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Sparkle } from "lucide-react";
import type { IntelReview, IntelVerdict } from "@/lib/grants/intel-review";

// The staff-only "Run IntellEngine Intel" control + verdict display, in the console ScoreCard footer.
//
// It rides the console's default-null `intel` slot (same pattern as scoreFactors / feedback / rematch),
// so the client portal never passes it and it can only render for staff. The verdict it shows is RAW
// internal QA voice — deliberately never surfaced on any client-facing page.
//
// ANNOTATE-ONLY: running it never changes the card's score/seat/decision. It writes a QA note; the
// score line on this card does not move. So there is nothing to refresh on the rest of the page — the
// panel just shows the returned verdict inline. Styled for the dark ScoreCard (white-on-chrome).

export function IntelReviewPanel({ cardId, initial }: { cardId: string; initial: IntelReview | null }) {
  const [intel, setIntel] = useState<IntelReview | null>(initial);
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPhase("running");
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/intel`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; intel?: IntelReview };
      if (!res.ok || !data.intel) throw new Error(data.error || "QA couldn't run");
      setIntel(data.intel);
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "QA couldn't run");
      setPhase("error");
    }
  }

  const running = phase === "running";

  if (intel) {
    return <Verdict intel={intel} onRerun={run} running={running} error={error} />;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        disabled={running}
        onClick={() => void run()}
        className="inline-flex items-center gap-[7px] text-[12px] font-semibold text-white/85 transition-colors hover:text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
      >
        {running ? <Loader2 className="h-[13px] w-[13px] animate-spin" aria-hidden="true" /> : <Sparkle className="h-[13px] w-[13px]" aria-hidden="true" />}
        {running ? "Reviewing… (up to a few minutes)" : "Run IntellEngine Intel"}
      </button>
      <p className="text-[11px] leading-[1.45] text-white/50">
        Opus + web check of this pair against the authoritative source. Adds a QA note — it never changes the score.
      </p>
      {error && <p className="text-[11px] text-orange-200">{error}</p>}
    </div>
  );
}

// Defense-in-depth: source_url is model output, blanked at store time if not http(s) — guard again
// here so an anchor is only ever rendered for a safe scheme (never javascript:/data:).
function safeHref(u: string): string | null {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:" ? u : null;
  } catch {
    return null;
  }
}

const VERDICT_STYLE: Record<IntelVerdict, { label: string; className: string }> = {
  demote: { label: "Demote", className: "text-orange-200" },
  flag: { label: "Flag", className: "text-orange-200" },
  affirm: { label: "Affirm", className: "text-white/85" },
  unverified: { label: "Unverified", className: "text-white/55" },
};

function Verdict({
  intel,
  onRerun,
  running,
  error,
}: {
  intel: IntelReview;
  onRerun: () => void;
  running: boolean;
  error: string | null;
}) {
  const v = VERDICT_STYLE[intel.verdict];
  const scoreMove =
    intel.verdict === "demote" && intel.engine_fit_score != null && intel.qa_fit_score != null
      ? ` · engine ${intel.engine_fit_score} → QA ${intel.qa_fit_score}`
      : "";
  const hasDetail = intel.evidence.length > 0 || intel.fetched.length > 0;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-white/45">IntellEngine Intel</p>
      <p className="text-[12px]">
        <span className={`font-bold ${v.className}`}>{v.label}</span>
        <span className="text-white/55">{scoreMove}</span>
      </p>
      <p className="text-[11.5px] leading-[1.5] text-white/75">{intel.summary}</p>

      {hasDetail && (
        <details className="w-full text-[11px] text-white/60">
          <summary className="cursor-pointer select-none text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome">
            Evidence &amp; sources
          </summary>
          <div className="mt-1.5 space-y-2">
            {intel.evidence.map((e, i) => (
              <div key={i} className="border-l border-white/15 pl-2">
                <p className="text-white/75">{e.claim}</p>
                {e.quote && <p className="mt-0.5 italic text-white/55">“{e.quote}”</p>}
                {safeHref(e.source_url) && (
                  <a
                    href={safeHref(e.source_url)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-white/70 underline underline-offset-2 hover:text-white"
                  >
                    source <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            ))}
            {intel.fetched.length > 0 && (
              <div className="pt-1">
                <p className="text-white/45">Pages fetched:</p>
                <ul className="mt-0.5 space-y-0.5">
                  {intel.fetched.map((f, i) => (
                    <li key={i} className="truncate">
                      <span className={f.ok ? "text-white/60" : "text-orange-200"}>{f.ok ? "✓" : "✕"}</span>{" "}
                      <span className="text-white/55">{f.finalUrl ?? f.url}</span>
                      {!f.ok && f.reason && <span className="text-orange-200/80"> ({f.reason})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      <button
        type="button"
        disabled={running}
        onClick={() => void onRerun()}
        className="inline-flex items-center gap-1.5 text-[11px] text-white/55 transition-colors hover:text-white/85 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
      >
        {running ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Sparkle className="h-3 w-3" aria-hidden="true" />}
        {running ? "Re-reviewing…" : "Re-run"}
      </button>
      {error && <p className="text-[11px] text-orange-200">{error}</p>}
    </div>
  );
}
