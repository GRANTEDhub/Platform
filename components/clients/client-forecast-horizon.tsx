"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

// The forecasted "On the horizon" sub-section for a client (Horizon Reject gate).
// Forecasted grants are never scored into review_cards, so this is a separate surface
// from the Matches table above: an LLM-ranked relevance shortlist (title, funder,
// rationale) with a per-row Reject. A reject is recorded in forecast_rejections and
// hidden from BOTH this view and the client's emailed horizon PDF; it does NOT carry
// through a forecast->posted flip (the grant re-enters the real match pool fresh).
//
// Interaction: OPTIMISTIC client-side hide, no re-fetch. Reject hides the row
// immediately; the server filter (loadForecastCandidates) keeps it hidden on the next
// full page load. Undo is the reverse. A11y: reject/active state is conveyed by a text
// label + icon, NEVER color alone (Shannon is colorblind).

type HorizonItem = { grantId: string; title: string; funder: string | null; rationale: string; sourceUrl: string | null };
type RejectedItem = { grantId: string; title: string; funder: string | null; sourceUrl: string | null };

// Forecasted rows have no in-app detail page (no NOFO yet), so link out to the live
// Simpler.gov opportunity page. Render ONLY for a real http(s) URL -- this drops null
// and the 'manual-paste' sentinel, so a row without a usable source shows no link
// rather than a broken one.
function sourceHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function SourceLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-orange underline-offset-2 hover:underline"
    >
      View on Simpler <span aria-hidden="true">↗</span>
    </a>
  );
}

export function ClientForecastHorizon({
  clientId,
  active,
  rejected,
}: {
  clientId: string;
  active: HorizonItem[];
  rejected: RejectedItem[];
}) {
  // Local optimistic overlays on top of the server-provided lists.
  const [locallyRejected, setLocallyRejected] = useState<Map<string, RejectedItem>>(new Map());
  const [locallyRestored, setLocallyRestored] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // Active = server horizon minus anything rejected this session.
  const displayActive = useMemo(
    () => active.filter((a) => !locallyRejected.has(a.grantId)),
    [active, locallyRejected],
  );

  // Rejected group = server rejects (minus undone) plus this session's rejects.
  const displayRejected = useMemo(() => {
    const fromServer = rejected.filter((r) => !locallyRestored.has(r.grantId));
    const fromSession = [...locallyRejected.values()].filter((r) => !locallyRestored.has(r.grantId));
    const seen = new Set(fromServer.map((r) => r.grantId));
    return [...fromServer, ...fromSession.filter((r) => !seen.has(r.grantId))];
  }, [rejected, locallyRejected, locallyRestored]);

  async function reject(item: HorizonItem) {
    setError(null);
    setBusyFor(item.grantId, true);
    setLocallyRejected((prev) =>
      new Map(prev).set(item.grantId, {
        grantId: item.grantId,
        title: item.title,
        funder: item.funder,
        sourceUrl: item.sourceUrl,
      }),
    );
    setLocallyRestored((prev) => {
      const n = new Set(prev);
      n.delete(item.grantId);
      return n;
    });
    try {
      const res = await fetch(`/api/clients/${clientId}/forecast-reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId: item.grantId }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Reject failed");
    } catch (e) {
      // Roll the optimistic hide back so the row reappears.
      setLocallyRejected((prev) => {
        const n = new Map(prev);
        n.delete(item.grantId);
        return n;
      });
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusyFor(item.grantId, false);
    }
  }

  async function undo(grantId: string) {
    setError(null);
    setBusyFor(grantId, true);
    setLocallyRestored((prev) => new Set(prev).add(grantId));
    setLocallyRejected((prev) => {
      const n = new Map(prev);
      n.delete(grantId);
      return n;
    });
    try {
      const res = await fetch(`/api/clients/${clientId}/forecast-reject`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Undo failed");
    } catch (e) {
      // Roll back: put it back into the rejected group.
      setLocallyRestored((prev) => {
        const n = new Set(prev);
        n.delete(grantId);
        return n;
      });
      setError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setBusyFor(grantId, false);
    }
  }

  // Count of items undone this session (they reappear in the ranked horizon only on
  // the next full load, since we don't re-rank on click) -- surfaced as an honest hint.
  const restoredCount = useMemo(
    () => [...locallyRestored].filter((id) => rejected.some((r) => r.grantId === id)).length,
    [locallyRestored, rejected],
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-serif text-lg font-semibold text-brand-navy">On the horizon · forecasted</h2>
        <p className="text-xs text-muted-foreground">
          Anticipated postings relevant to this client (relevance-ranked, no fit score yet). Reject one to drop
          it from this client&apos;s horizon and their emailed alert. A rejected forecast that later posts gets a
          fresh look as an active match.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-hidden rounded-lg border bg-card">
        {displayActive.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No forecasted opportunities on the horizon for this client right now.
          </p>
        ) : (
          <ul className="divide-y">
            {displayActive.map((item) => (
              <li key={item.grantId} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.title}</p>
                  {item.funder && <p className="truncate text-xs text-muted-foreground">{item.funder}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{item.rationale}</p>
                  {sourceHref(item.sourceUrl) && (
                    <p className="mt-1">
                      <SourceLink href={sourceHref(item.sourceUrl)} />
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reject(item)}
                  disabled={busy.has(item.grantId)}
                  aria-label={`Reject ${item.title} for this client's horizon`}
                >
                  {busy.has(item.grantId) ? "Rejecting…" : "Reject"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {displayRejected.length > 0 && (
        <div className="rounded-lg border bg-muted/30">
          <button
            type="button"
            onClick={() => setShowRejected((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-muted-foreground"
            aria-expanded={showRejected}
          >
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true">⊘</span> Rejected ({displayRejected.length})
            </span>
            <span aria-hidden="true">{showRejected ? "▾" : "▸"}</span>
          </button>
          {showRejected && (
            <ul className="divide-y border-t">
              {displayRejected.map((item) => (
                <li key={item.grantId} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="inline-flex items-center gap-1.5 truncate text-sm">
                      <span
                        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                        aria-label="Rejected"
                      >
                        <span aria-hidden="true">⊘</span> Rejected
                      </span>
                      <span className="truncate line-through decoration-1">{item.title}</span>
                    </p>
                    {item.funder && <p className="truncate pl-1 text-xs text-muted-foreground">{item.funder}</p>}
                    {sourceHref(item.sourceUrl) && (
                      <p className="pl-1">
                        <SourceLink href={sourceHref(item.sourceUrl)} />
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => undo(item.grantId)}
                    disabled={busy.has(item.grantId)}
                    aria-label={`Undo reject of ${item.title}`}
                  >
                    {busy.has(item.grantId) ? "Undoing…" : "Undo"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {restoredCount > 0 && (
            <p className="px-4 py-2 text-[11px] text-muted-foreground">
              {restoredCount} restored — {restoredCount === 1 ? "it reappears" : "they reappear"} in the ranked
              horizon on the next page refresh.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
