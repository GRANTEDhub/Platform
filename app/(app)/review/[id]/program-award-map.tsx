"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import STATE_PATHS_JSON from "@/lib/geo/us-states-albers.json";
import type { ProgramAwardSummary } from "@/lib/grants/program-awards";

// #107 Part 3 — the program-award-history map. Reads the cached
// program_award_summary (Part 2) and renders an honest, program-wide choropleth:
// per-state amount fill (colorblind-safe single-hue navy lightness ramp, quantile
// bins), hover -> count + amount, click a state -> filter the award table. The US
// state paths are pre-baked (Albers-USA) and BUNDLED (lib/geo) -- serverless has no
// CDN egress, so nothing loads a map from a URL.

const STATE_PATHS = STATE_PATHS_JSON as Record<string, string>;

// Single navy hue, lightness only (magnitude reads regardless of color vision);
// the legend + tooltip always carry the real numbers so color is never the sole
// signal. No-data is near-white, clearly lighter than the lowest data bin.
const FILLS = ["#bcc7d6", "#8b9db8", "#56708f", "#2c4569", "#0B1E3A"];
const NODATA_FILL = "#f5f6f8";
const NODATA_BORDER = "#d6dbe3";
const SELECTED_STROKE = "#E4761F";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

// Quantile thresholds over the states that have awards -> 5 bins. Quantiles (not
// fixed cutoffs) keep every map readable regardless of program size.
function quantileThresholds(amounts: number[], bins = 5): number[] {
  const sorted = amounts.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const out: number[] = [];
  for (let i = 1; i < bins; i++) {
    const idx = Math.min(sorted.length - 1, Math.floor((i / bins) * sorted.length));
    out.push(sorted[idx]);
  }
  return out;
}
function binOf(amount: number, thresholds: number[]): number {
  let b = 0;
  for (const t of thresholds) if (amount >= t) b++;
  return b;
}

function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <Card className="p-6 sm:p-7">
      <SectionLabel>Program award history</SectionLabel>
      {children}
    </Card>
  );
}

export function ProgramAwardMap({
  grantId,
  initialSummary,
  hasCfda,
}: {
  grantId: string;
  initialSummary: ProgramAwardSummary | null;
  hasCfda: boolean;
}) {
  const [summary, setSummary] = useState<ProgramAwardSummary | null>(initialSummary);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ code: string; left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lazy fetch-on-view: a grant with a CFDA but no cached summary (not yet swept)
  // fetches once on mount; a populated grant server-renders with no fetch.
  useEffect(() => {
    if (initialSummary || !hasCfda) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/grants/${grantId}/program-awards`)
      .then((r) => {
        // A non-OK response (e.g. 502 upstream USASpending failure) must surface the
        // "Couldn't load" error, NOT fall through to the "No data" state.
        if (!r.ok) throw new Error(`Request failed: ${r.status}`);
        return r.json();
      })
      .then((d: { summary?: ProgramAwardSummary | null }) => {
        if (!cancelled) setSummary(d.summary ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [grantId, hasCfda, initialSummary]);

  const byStateMap = useMemo(() => {
    const m = new Map<string, { amount: number; count: number; name: string }>();
    for (const s of summary?.byState ?? []) m.set(s.state, { amount: s.amount, count: s.count, name: s.name });
    return m;
  }, [summary]);

  const thresholds = useMemo(
    () => quantileThresholds((summary?.byState ?? []).map((s) => s.amount)),
    [summary],
  );

  // Loading / null / failure states (each still inside the section shell).
  if (loading) {
    return (
      <SectionShell>
        <div className="mt-2.5 flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-navy/20 border-t-brand-orange" />
          Loading program award history…
        </div>
      </SectionShell>
    );
  }
  if (!summary || summary.byState.length === 0) {
    return (
      <SectionShell>
        <p className="mt-2 text-sm text-muted-foreground">
          {failed ? "Couldn’t load program award history." : "No program award history available."}
        </p>
      </SectionShell>
    );
  }

  const legend = FILLS.map((fill, i) => {
    const lo = i === 0 ? 0 : thresholds[i - 1];
    const hi = thresholds[i];
    const label =
      i === 0
        ? `< ${fmtUsd(thresholds[0] ?? Infinity)}`
        : i === FILLS.length - 1
          ? `${fmtUsd(lo)}+`
          : `${fmtUsd(lo)}–${fmtUsd(hi)}`;
    return { fill, label };
  });

  const selName = selected ? STATE_NAMES[selected] ?? selected : null;
  const rows = (summary.topAwards ?? []).filter((a) => !selected || a.state === selected);

  const label = `${summary.cfdas.join(", ")}${summary.programTitles.length ? ` — ${summary.programTitles.join("; ")}` : ""}`;
  const startYear = (summary.timePeriod?.start ?? "").slice(0, 4);

  return (
    <SectionShell>
      {/* Honest, program-wide label -- never "this grant's awards". */}
      <p className="mt-2 text-sm leading-relaxed text-foreground">
        <span className="font-semibold text-brand-navy">{label}</span> · program-wide, all competitions
        {startYear ? `, ${startYear}–present` : ""}.{" "}
        <span className="italic text-muted-foreground">Not specific to this opportunity.</span>
      </p>
      <p className="mt-2 text-[13px] text-muted-foreground">
        <span className="font-semibold text-brand-navy">{fmtUsd(summary.totalAmount)}</span> awarded nationwide
        {summary.awardsTruncated ? " · 500+ awards" : ` · ${summary.totalAwardsFetched} awards`} · recipient HQ state
      </p>

      {/* Choropleth */}
      <div ref={wrapRef} className="relative mt-4">
        <svg viewBox="0 0 975 610" className="block h-auto w-full" role="img" aria-label="Program awards by recipient state">
          {Object.entries(STATE_PATHS).map(([code, d]) => {
            const rec = byStateMap.get(code);
            const isSel = selected === code;
            const fill = rec ? FILLS[binOf(rec.amount, thresholds)] : NODATA_FILL;
            return (
              <path
                key={code}
                d={d}
                fill={fill}
                stroke={isSel ? SELECTED_STROKE : rec ? "#ffffff" : NODATA_BORDER}
                strokeWidth={isSel ? 2.2 : 0.75}
                style={{ cursor: rec ? "pointer" : "default" }}
                onMouseMove={(e) => {
                  const box = wrapRef.current?.getBoundingClientRect();
                  if (!box) return;
                  setHover({ code, left: e.clientX - box.left, top: e.clientY - box.top });
                }}
                onMouseLeave={() => setHover((h) => (h?.code === code ? null : h))}
                onClick={() => {
                  if (!rec) return;
                  setSelected((s) => (s === code ? null : code));
                }}
              />
            );
          })}
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded-lg bg-brand-navy px-3 py-1.5 text-xs text-white shadow-lg"
            style={{ left: hover.left, top: hover.top }}
          >
            {(() => {
              const rec = byStateMap.get(hover.code);
              const name = rec?.name ?? STATE_NAMES[hover.code] ?? hover.code;
              return rec ? (
                <>
                  <span className="font-semibold">{name}</span> — {rec.count} award{rec.count === 1 ? "" : "s"} ·{" "}
                  {fmtUsd(rec.amount)}
                </>
              ) : (
                <>
                  <span className="font-semibold">{name}</span> — no awards
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Legend — ranges as text so magnitude never depends on hue. */}
      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 border-t border-brand-navy/[0.08] pt-2.5">
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-3.5 w-3.5 rounded-[3px]" style={{ background: l.fill }} />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-3.5 w-3.5 rounded-[3px]" style={{ background: NODATA_FILL, border: `1px solid ${NODATA_BORDER}` }} />
          No data
        </span>
      </div>

      {/* Selection chip + truncation note */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {selName && (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-orange/[0.12] px-3 py-0.5 text-xs font-semibold text-brand-orange"
          >
            Showing: {selName} <span aria-hidden className="opacity-70">✕</span>
          </button>
        )}
        {summary.awardsTruncated && (
          <span className="text-[11px] text-muted-foreground">
            Showing top {summary.topAwards.length} of 500+ awards — per-state counts are a floor.
          </span>
        )}
      </div>

      {/* Award table */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-navy/[0.08] text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Recipient</th>
              <th className="py-2 pr-3 font-medium">Amount</th>
              <th className="py-2 pr-3 font-medium">Agency</th>
              <th className="py-2 pr-3 font-medium">Start</th>
              <th className="py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-sm text-muted-foreground">
                  No awards to show{selName ? ` for ${selName}` : ""}.
                </td>
              </tr>
            ) : (
              rows.map((a, i) => (
                <tr key={`${a.awardId}-${i}`} className="border-b border-brand-navy/[0.06] last:border-0">
                  <td className="py-2 pr-3 text-foreground">{a.recipient || "—"}</td>
                  <td className="py-2 pr-3 font-semibold tabular-nums text-brand-navy">{fmtUsd(a.amount)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{a.agency || "—"}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{(a.startDate || "").slice(0, 10) || "—"}</td>
                  <td className="py-2 text-muted-foreground">{a.state ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}
