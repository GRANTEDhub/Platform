"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { isOverdue } from "@/lib/report/shape";

// The overdue confirmation, shared by all three terminal actions on the grant review
// screen: Generate concept proposal, Release to client, Send grant alert.
//
// WHY A GATE AND NOT JUST A RED CELL. The red Deadline cell tells you; this stops you.
// Two of the three actions are irreversible in the way that matters — an email to a
// client about a grant that closed last week is not something a later archive undoes —
// and the review loop is a dozens-a-morning, muscle-memory surface. A reviewer moving at
// that speed reads the score and the verdict, not the date.
//
// IT OFFERS THE LIKELY ACTION, NOT JUST CONSENT. Once you know a grant has closed, the
// thing you almost always want is it off the report — so Archive is a peer of
// Acknowledge, not a link buried in the copy. A dialog whose only exit is "proceed
// anyway" trains people to click through it.
//
// TWO THRESHOLDS, DELIBERATELY. It warns from the deadline DAY (daysLeft <= 0) but only
// offers Archive once the day has PASSED (daysLeft < 0). A federal deadline usually has a
// time-of-day cutoff we do not store, so a grant due today is still winnable and
// archiving it would be the destructive answer to a live opportunity. "Closed" elsewhere
// in the product (the Grant Report's closed rows, the bulk sweep) stays at < 0 — this
// component's warning threshold is deliberately wider than that definition, not a
// redefinition of it.

export interface OverdueGateConfig {
  cardId: string;
  daysLeft: number | null;
  deadlineLabel: string | null;
  backHref: string;
}

// The call-site half. Wrap an action in `guard(...)` and render `gate` — two lines per
// button, which is what keeps three different components honest about using it.
//
// ACKNOWLEDGING ONCE COVERS THE VISIT. A reviewer who has just been told the deadline
// passed and chose to continue does not need telling again when they open the release
// menu, pick a send mode, and confirm. Re-prompting through one workflow is how a dialog
// becomes something people dismiss without reading. Per component instance, so leaving
// and coming back asks again.
export function useOverdueGate(config: OverdueGateConfig, actionLabel: string) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  function guard(run: () => void) {
    if (!acknowledged && isOverdue(config.daysLeft)) {
      setPending(() => run);
      return;
    }
    run();
  }

  const gate = pending ? (
    <OverdueGate
      {...config}
      actionLabel={actionLabel}
      onAcknowledge={() => {
        const run = pending;
        setAcknowledged(true);
        setPending(null);
        run();
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { guard, gate };
}

export function OverdueGate({
  cardId,
  daysLeft,
  deadlineLabel,
  actionLabel,
  backHref,
  onAcknowledge,
  onCancel,
}: {
  cardId: string;
  // Null when there is no parseable deadline — the caller should not render this at all
  // in that case; a missing deadline is not an expired one.
  daysLeft: number | null;
  deadlineLabel: string | null;
  // "Send grant alert" / "Release to client" / "Generate concept proposal" — named so the
  // dialog says which action it is holding rather than a generic "continue".
  actionLabel: string;
  // Where Archive returns to (the Grant Report). Archiving removes the card from the
  // queue, so staying on its detail page would leave you looking at a decided card.
  backHref: string;
  onAcknowledge: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PORTALLED TO <body>, like AlertSend's modal. This renders from inside the review
  // screen's rail — a flex column inside an `overflow-hidden` frame — and a fixed overlay
  // nested there is one transformed ancestor away from being clipped into a 386px column.
  // The two-pass mount is what keeps SSR and the first client render identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Escape cancels. A modal you cannot dismiss from the keyboard is a modal people
  // dismiss by reloading, which on this screen loses nothing but teaches the wrong habit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const past = daysLeft !== null && daysLeft < 0;
  const daysAgo = past ? Math.abs(daysLeft!) : 0;

  if (!mounted) return null;

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      // The existing bulk endpoint, one id. It RE-DERIVES the passed deadline server-side
      // rather than trusting this dialog, so a stale tab cannot archive a live grant.
      //
      // include_released relaxes ONE check: the bulk sweep refuses a card the client has
      // already seen, which is right for a sweep and wrong here. A human looking at this
      // card, acknowledging the date, is the case the sweep is protecting against — and
      // leaving a closed card released means it sits in the client's own Grant Report
      // looking like a live opportunity.
      const res = await fetch("/api/review/archive-closed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_ids: [cardId], include_released: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; archived?: number };
      if (!res.ok) throw new Error(data.error || "Couldn't archive that");
      if (!data.archived) {
        // Skipped-and-counted: the server disagreed that this card qualifies (already
        // decided, or the deadline is not actually past). Say so rather than navigating
        // away as though it worked.
        throw new Error("This card no longer qualifies to archive — reload and check its state.");
      }
      router.push(backHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't archive that");
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-chrome/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`overdue-${cardId}`}
    >
      <div className="w-full max-w-[430px] rounded-sharp border border-edge bg-white p-5 shadow-lg">
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            className="mt-px h-4 w-4 shrink-0"
            style={{ color: BRAND.reject }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 id={`overdue-${cardId}`} className="font-serif text-[16px] font-bold text-brand-navy">
              {past ? "This grant's deadline has passed" : "This grant closes today"}
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-muted">
              {past ? (
                <>
                  The deadline was{" "}
                  <strong className="font-semibold text-brand-navy">
                    {daysAgo} {daysAgo === 1 ? "day" : "days"} ago
                  </strong>
                  {deadlineLabel ? ` (${deadlineLabel})` : ""}. {actionLabel} anyway?
                </>
              ) : (
                <>
                  The deadline is{" "}
                  <strong className="font-semibold text-brand-navy">today</strong>
                  {deadlineLabel ? ` (${deadlineLabel})` : ""}, and most federal deadlines have a
                  cut-off time we don&apos;t track. Check the NOFO before you send.
                </>
              )}
            </p>
          </div>
        </div>

        {error && <p className="mt-3 text-[11.5px] leading-[1.45] text-brand-reject">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onAcknowledge}
            className="inline-flex h-9 flex-1 items-center justify-center rounded-sharp bg-brand-chrome px-3.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
          >
            Acknowledge and continue
          </button>
          {/* Archive only once the day is gone — see the two-threshold note above. */}
          {past && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void archive()}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-sharp px-3.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
              style={{ backgroundColor: BRAND.reject }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Archive instead
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-sharp border border-edge px-3 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-brand-navy/25 hover:text-brand-navy disabled:opacity-60"
          >
            Cancel
          </button>
        </div>

        {past && (
          <p className="mt-2.5 text-[11px] leading-[1.45] text-ink-muted">
            Archiving records it as passed with the reason noted. It does not train the scorer —
            a missed deadline is a fact about our capacity, not about the match.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
