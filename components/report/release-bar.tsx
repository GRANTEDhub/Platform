"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, FileText, Loader2, Mail } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { ReleaseEmailPanel } from "./release-email-panel";
import { useOverdueGate, type OverdueGateConfig } from "./overdue-gate";

// "Your decision" — staff's Gate-2 control for an account-managed client (0059), and the
// terminal act of the grant review screen. The call here is "release to the client", not
// a pursue decision: the client makes that later, on their own copy of this page.
//
// A SPLIT BUTTON, not two peers. Releasing is what happens on most grants, and the two
// ways to do it differ only in what lands in the inbox; making them equal-weight siblings
// asked the reviewer to decide the format before deciding the answer. Reject sits below
// as a full-width secondary — routine and reversible, so it is bordered rather than
// filled, and it is not the shadcn destructive red (see BRAND.reject).
//
// Two ways to notify:
//   - Send alert -- the branded one-page PDF (the existing AlertSend flow).
//   - Send email -- a custom, editable plain-text note, no PDF.
// BOTH set sme_released_at (the card moves to the client's Grant Alerts) and NEITHER
// approves -- the client still decides pursuit. Reject is terminal (decision='passed').
export function ReleaseToClientBar({
  cardId,
  released,
  backHref,
  returnNote,
  overdue,
}: {
  cardId: string;
  released: boolean;
  // Where to land after a release/reject -- the card leaves this queue either way,
  // so staying on the now-stale detail page isn't useful.
  backHref: string;
  // "Either way you'll go back to the Grant Report — 9 left." The caller owns the count.
  returnNote: string;
  // Deadline context for the overdue confirmation. The heaviest of the three gated
  // actions: releasing puts the grant in the client's own Grant Alerts, and an alert
  // about a grant that closed last week is not something a later archive takes back.
  overdue: OverdueGateConfig;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<null | "alert" | "email">(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Guarded at setMode, not inside the send handlers: every release path — the primary
  // button and both menu items — goes through it, so one wrap covers all three and a new
  // release mode cannot be added past the gate by accident.
  const { guard, gate } = useOverdueGate(overdue, "Release it to the client");
  // Recall outcome, held locally rather than refreshing straight away: the response
  // carries the surviving send date and a refresh would re-render this component in its
  // NOT-released state, taking that sentence off the screen before it was read. The
  // caller's next navigation picks up the new state.
  const [recalled, setRecalled] = useState(false);
  const [recalledEmailedAt, setRecalledEmailedAt] = useState<string | null>(null);

  async function recall() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/recall`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; emailedAt?: string | null };
      if (!res.ok) throw new Error(data.error || "Couldn't recall that");
      setRecalledEmailedAt(data.emailedAt ?? null);
      setRecalled(true);
      // Refresh so the Grant Report count and the rest of the page reflect the recall.
      // This component keeps its own `recalled` state through it, so the outcome line
      // survives the re-render that would otherwise replace it with the release buttons.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't recall that");
    } finally {
      setBusy(false);
    }
  }

  // Outside-click + Escape close for the menu (mirrors the notification bell).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "passed" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      router.push(backHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  // BEFORE the `released` check, deliberately. router.refresh() re-renders the parent,
  // which now passes released=false — so without this the component would drop straight
  // into the release buttons and take the outcome line off the screen before it was read.
  // Local state, so it clears the moment you navigate.
  if (recalled) {
    return (
      <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
          Recalled — this grant is back in Awaiting release and is no longer in the client&apos;s portal.
        </p>
        {/* The email is the part a recall cannot reach, so it is stated outright rather
            than left for the reader to wonder about. grant_alerts keeps the record; a
            null date means the send was gated off (every preview deploy) and nothing
            actually reached them, which must not be reported as a sent email. */}
        <p className="mt-2 text-[11.5px] leading-[1.5] text-ink-muted">
          {recalledEmailedAt ? (
            <>
              The client was emailed on{" "}
              <strong className="font-semibold text-brand-navy">
                {new Date(recalledEmailedAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </strong>
              . That cannot be taken back.
            </>
          ) : (
            "No alert email had gone out, so nothing reached them."
          )}
        </p>
        <Link
          href={backHref}
          className="mt-3 inline-flex h-8 items-center rounded-sharp border border-edge px-3 text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/30"
        >
          Back to the Grant Report
        </Link>
      </section>
    );
  }

  if (released) {
    return (
      <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
          Released — the client now sees this in their own Grant Alerts.
        </p>

        {/* RECALL. The released state used to be terminal on this surface: a card released
            by mistake, or one you want back for another pass, could only be pulled by
            hand in SQL. It takes the card out of the client's portal and returns it to
            Awaiting release.
            The EMAIL is not recalled and the copy says so — grant_alerts keeps the send
            record, and after a successful recall this reports the real date rather than
            leaving the impression nothing went out. */}
        <div className="mt-3 border-t border-hairline-strong pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void recall()}
              className="inline-flex h-8 items-center gap-1.5 rounded-sharp border border-edge px-3 text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/30 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Recall from the client
            </button>
            <p className="mt-1.5 text-[11px] leading-[1.45] text-ink-muted">
              Removes it from their portal and returns it here. Any email already sent stays sent.
            </p>
        </div>
        {error && (
          <p className="mt-2 text-[11.5px] leading-[1.45]" style={{ color: BRAND.reject }}>
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]"
      style={{ borderTopWidth: "3px", borderTopColor: BRAND.orange }}
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
        Release to the client&apos;s Grant Alerts as a one-page PDF or a custom note — or reject to archive it now.
      </p>

      <div ref={wrapRef} className="relative mt-[13px] flex items-stretch gap-[2px]">
        <button
          type="button"
          disabled={busy}
          onClick={() => guard(() => setMode("alert"))}
          className="inline-flex h-[42px] flex-1 items-center justify-center gap-2 rounded-sharp bg-brand-orangeFill text-[14px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          Release to client
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Choose how to release"
          disabled={busy}
          onClick={() => setMenuOpen((v) => !v)}
          className="inline-flex h-[42px] w-[38px] shrink-0 items-center justify-center rounded-sharp bg-brand-orangeFill text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-sharp border border-edge bg-white shadow-overlay"
          >
            <MenuItem
              icon={<FileText className="mt-0.5 h-4 w-4 shrink-0" style={{ color: BRAND.orangeDeep }} />}
              title="Send alert"
              sub="The branded one-page PDF."
              onClick={() => {
                setMenuOpen(false);
                guard(() => setMode("alert"));
              }}
            />
            <MenuItem
              bordered
              icon={<Mail className="mt-0.5 h-4 w-4 shrink-0" style={{ color: BRAND.orangeDeep }} />}
              title="Send email"
              sub="A custom note, no PDF."
              onClick={() => {
                setMenuOpen(false);
                guard(() => setMode("email"));
              }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={reject}
        className="mt-[9px] inline-flex h-[38px] w-full items-center justify-center rounded-sharp border text-[13px] font-semibold transition-colors duration-[120ms] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        style={{ borderColor: "rgba(180,70,47,0.3)", color: BRAND.reject }}
      >
        {busy ? "Saving…" : "Reject"}
      </button>

      <p className="mt-[11px] text-[11px] leading-[1.45] text-ink-muted">{returnNote}</p>
      {error && <p className="mt-2 text-[12px]" style={{ color: BRAND.reject }}>{error}</p>}

      {gate}

      {/* Both drivers open their own modal on mount; onClose resets the dropdown. AlertSend
          gets NO `overdue` here on purpose — setMode is already gated above, and passing it
          would prompt a second time inside the same workflow. */}
      {mode === "alert" && <AlertSend cardId={cardId} autoOpen onClose={() => setMode(null)} />}
      {mode === "email" && <ReleaseEmailPanel cardId={cardId} backHref={backHref} onClose={() => setMode(null)} />}
    </section>
  );
}

function MenuItem({
  icon,
  title,
  sub,
  onClick,
  bordered,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  bordered?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-navy/[0.04] ${bordered ? "border-t border-hairline" : ""}`}
    >
      {icon}
      <span>
        <span className="block text-[13px] font-semibold text-brand-navy">{title}</span>
        <span className="block text-[12px] text-ink-muted">{sub}</span>
      </span>
    </button>
  );
}
