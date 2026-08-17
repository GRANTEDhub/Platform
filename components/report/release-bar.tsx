"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2 } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { useOverdueGate, type OverdueGateConfig } from "./overdue-gate";

// "Your decision" — staff's Gate-2 control for an account-managed client (0059), and the
// terminal act of the grant review screen. The call here is "release to the client", not
// a pursue decision: the client makes that later, on their own copy of this page.
//
// THREE STANDING STATES, keyed on where the card sits:
//   1. Awaiting release (not released, not passed) -> "Edit & Send Alert" + "Pass".
//   2. Released to the client -> a Recall control ("Recall from client").
//   3. Passed -> a Recall control ("Recall to review queue").
// (2) and (3) are the "it has LEFT Awaiting release" states: the send/pass control would be
// wrong there -- there is nothing left to send or pass -- so both show a Recall dropdown
// instead (state-aware label; the same reset either way, see RecallDropdown + the recall
// route). Before this a PASSED card fell through to (1) and kept offering Edit & Send / Pass
// on a grant already in the Passed tab.
//
// ONE WAY TO NOTIFY: "Edit & Send Alert" (the one-pager PDF). Releasing sets sme_released_at
// (the card moves to the client's Grant Alerts) and does NOT approve -- the client still
// decides pursuit. Pass is terminal (decision='passed') and now REQUIRES a reason: it is the
// staff calibration signal, routed to match_feedback server-side, and the server records a
// datapoint only when a reason is present (mirrors the client DecisionBar). Same discipline as
// the client Pass -- an empty pass silently dropped the "this match was wrong" signal.
export function ReleaseToClientBar({
  cardId,
  released,
  passed,
  backHref,
  doneHref,
  doneLabel,
  returnNote,
  overdue,
}: {
  cardId: string;
  released: boolean;
  // decision === 'passed'. A passed card has left Awaiting release, so it shows the Recall
  // control rather than falling through to Edit & Send / Pass.
  passed: boolean;
  // Where the recall outcome / released state's "Back to the Grant Report" link goes -- the
  // client's Grant Report, since a recall returns the card there.
  backHref: string;
  // #8: where a send/pass DECISION lands. The Grant Report while this client still has grants
  // pending review, else the client's dashboard. Computed on the page from the remaining count,
  // and threaded into AlertSend's release confirmation so a send lands there too (not /matches).
  doneHref: string;
  // Human label for the redirect line on the release confirmation ("Redirecting to <x>…").
  doneLabel: string;
  // "Either way you'll go back to the Grant Report — 9 left." The caller owns the count.
  returnNote: string;
  // Deadline context for the overdue confirmation. Gates the RELEASE only (not Pass, not Recall).
  overdue: OverdueGateConfig;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "alert">(null);
  // #6-console: the Pass reason step. Pass opens it; the confirm stays disabled until a
  // non-empty reason is entered, so a console pass always carries the calibration signal.
  const [showPass, setShowPass] = useState(false);
  const [passReason, setPassReason] = useState("");
  // Guarded at setMode, not inside the send handlers: every release path goes through it.
  const { guard, gate } = useOverdueGate(overdue, "Release it to the client");
  // Recall outcome, held locally rather than refreshing straight away: the response carries
  // the surviving send date and a refresh would re-render this component in its now-pending
  // state, taking that sentence off the screen before it was read.
  const [recalled, setRecalled] = useState(false);
  const [recalledEmailedAt, setRecalledEmailedAt] = useState<string | null>(null);
  const [recalledDraft, setRecalledDraft] = useState<string | null>(null);
  // Set when the route reports a proposal draft in the way. Holds the question inline
  // rather than sending the reviewer off to IntellEngine to get unstuck.
  const [draftBlock, setDraftBlock] = useState<{ status: string } | null>(null);

  async function recall(deleteDraft = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        emailedAt?: string | null;
        needsDraftDelete?: boolean;
        draftStatus?: string;
        deletedDraft?: { status: string } | null;
      };
      // The draft question, not a failure: surface the choice and stop, leaving the
      // recall control in place if they would rather not.
      if (res.status === 409 && data.needsDraftDelete) {
        setDraftBlock({ status: data.draftStatus ?? "in progress" });
        return;
      }
      if (!res.ok) throw new Error(data.error || "Couldn't recall that");
      setRecalledEmailedAt(data.emailedAt ?? null);
      setRecalledDraft(data.deletedDraft?.status ?? null);
      setDraftBlock(null);
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

  async function reject(reason: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // #6-console: the reason rides here and the server routes it to match_feedback
        // (recordCardFeedback) as the negative calibration datapoint.
        body: JSON.stringify({ decision: "passed", decision_reason: reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      // #8: land on the Grant Report if this client still has grants pending review, else
      // the client's dashboard -- never the cross-client Matches queue.
      router.push(doneHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  // BEFORE the released/passed checks, deliberately. router.refresh() re-renders the parent,
  // which now passes released=false/passed=false -- so without this the component would drop
  // into the awaiting-release buttons and take the outcome line off the screen before it was
  // read. Local state, so it clears the moment you navigate.
  if (recalled) {
    return (
      <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
          Recalled — this grant is back in Awaiting release for another pass.
        </p>
        {recalledDraft && (
          <p className="mt-2 text-[11.5px] leading-[1.5] text-ink-muted">
            The attached {recalledDraft === "complete" ? "completed" : recalledDraft} proposal draft was
            deleted with it.
          </p>
        )}
        {/* The email is the part a recall cannot reach, so it is stated outright rather
            than left for the reader to wonder about. grant_alerts keeps the record; a
            null date means no alert email ever went out (a passed card that was never
            released, or a release the send gate suppressed) — never reported as a send. */}
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

  // ── LEFT AWAITING RELEASE: released to the client OR passed. Both show a Recall control
  // (state-aware label), never the send/pass buttons. `passed` is checked first because a
  // card passed by the client after release is both released and passed, and staffBucket
  // files it under Passed -- so "Recall to review queue" (un-pass) is the honest label. ──
  if (passed || released) {
    return (
      <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
          {passed
            ? "Passed — this grant sits in the Passed tab, out of Awaiting release."
            : "Released — the client now sees this in their own Grant Alerts."}
        </p>

        <div className="mt-3 border-t border-hairline-strong pt-3">
          {draftBlock && (
            // Names the draft's STAGE on purpose. Deleting a completed proposal is a
            // different decision from deleting a scoping stub, and neither can be undone.
            <div className="mb-2.5">
              <p className="text-[12px] leading-[1.5]" style={{ color: BRAND.reject }}>
                A {draftBlock.status === "complete" ? "completed" : draftBlock.status} proposal draft is
                attached to this grant in IntellEngine. Delete it to recall?
              </p>
              <p className="mt-1 text-[11px] leading-[1.45] text-ink-muted">
                Deleting the proposal cannot be undone.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void recall(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-sharp px-3 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: BRAND.reject }}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  Delete and recall
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDraftBlock(null)}
                  className="inline-flex h-8 items-center rounded-sharp border border-edge px-3 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-brand-navy/25 hover:text-brand-navy disabled:opacity-60"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
          <RecallDropdown
            // State-aware label: the card either came back FROM the client (released) or up
            // FROM the Passed tab. Both call the same recall route -- one reset to Awaiting
            // release -- so the difference is only which state it is leaving.
            label={passed ? "Recall to review queue" : "Recall from client"}
            description={
              passed
                ? "Un-passes it and returns it to Awaiting release for another look."
                : "Removes it from their portal and returns it to Awaiting release. Any email already sent stays sent."
            }
            busy={busy}
            onRecall={() => void recall()}
          />
        </div>
        {error && (
          <p className="mt-2 text-[11.5px] leading-[1.45]" style={{ color: BRAND.reject }}>
            {error}
          </p>
        )}
      </section>
    );
  }

  // ── AWAITING RELEASE: the live send/pass control. ──
  return (
    <section
      className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]"
      style={{ borderTopWidth: "3px", borderTopColor: BRAND.orange }}
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
        Release to the client&apos;s Grant Alerts with the one-page PDF — edit the note before it goes — or pass to
        archive it now.
      </p>

      <div className="mt-[13px]">
        <button
          type="button"
          disabled={busy}
          onClick={() => guard(() => setMode("alert"))}
          className="inline-flex h-[42px] w-full items-center justify-center gap-2 rounded-sharp bg-brand-orangeFill text-[14px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          Edit &amp; Send Alert
        </button>
      </div>

      {!showPass ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowPass(true)}
          className="mt-[9px] inline-flex h-[38px] w-full items-center justify-center rounded-sharp border text-[13px] font-semibold transition-colors duration-[120ms] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
          style={{ borderColor: "rgba(180,70,47,0.3)", color: BRAND.reject }}
        >
          Pass
        </button>
      ) : (
        // #6-console: a REQUIRED reason before the pass commits. The confirm stays disabled
        // until a non-empty reason is entered; the reason is the staff calibration signal.
        <div className="mt-[9px] space-y-2 rounded-sharp border border-edge bg-brand-cream/40 p-3">
          <p className="text-[12px] font-medium leading-[1.5] text-brand-navy">
            Why pass? This tunes the client&apos;s future matches — tell us what&apos;s off so the engine sends
            fewer like it.
          </p>
          <textarea
            value={passReason}
            onChange={(e) => setPassReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="e.g. wrong geography, no capacity this cycle, equipment-only"
            className="w-full rounded-sharp border border-input bg-white px-3 py-2 text-[13px] outline-none focus:border-brand-navy/35"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !passReason.trim()}
              onClick={() => void reject(passReason.trim())}
              className="inline-flex h-8 items-center gap-1.5 rounded-sharp px-4 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: BRAND.reject }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Pass on this match
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowPass(false);
                setPassReason("");
              }}
              className="inline-flex h-8 items-center rounded-sharp border border-edge px-3 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-brand-navy/25 hover:text-brand-navy disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="mt-[11px] text-[11px] leading-[1.45] text-ink-muted">{returnNote}</p>
      {error && <p className="mt-2 text-[12px]" style={{ color: BRAND.reject }}>{error}</p>}

      {gate}

      {/* AlertSend gets NO `overdue` here on purpose — setMode is already gated above. It DOES
          get doneHref/doneLabel so its release confirmation lands where a decision should
          (Grant Report or dashboard), not on /matches. */}
      {mode === "alert" && (
        <AlertSend cardId={cardId} autoOpen onClose={() => setMode(null)} doneHref={doneHref} doneLabel={doneLabel} />
      )}
    </section>
  );
}

// The Recall control — a dropdown anchored to its trigger. One item today (the state-aware
// recall), in a menu so the affordance reads as "there is a recall action here" rather than a
// bare button, and so a second recall path can be added without changing the shape.
//
// The menu is PORTAL-rendered on document.body at fixed coords from the trigger's rect. The
// grant review console body is `overflow-hidden` (see grant-review-console.tsx), so an in-flow
// absolute menu would be CLIPPED by it near the bottom of the rail — the same hazard the
// rationale pop-out hit (CLAUDE.md). The portal escapes every clipping ancestor.
function RecallDropdown({
  label,
  description,
  busy,
  onRecall,
}: {
  label: string;
  description: string;
  busy: boolean;
  onRecall: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    // Capture-phase so the console's own scroll containers are caught; and close on Escape.
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  return (
    <div className="inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-sharp border border-edge px-3 text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/30 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        Recall
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-away scrim closes the menu without stealing the first click elsewhere. */}
            <div className="fixed inset-0 z-[70]" aria-hidden="true" onClick={() => setOpen(false)} />
            <div
              role="menu"
              className="fixed z-[71] w-64 rounded-sharp border border-edge bg-white p-1 shadow-lg"
              style={{ left: pos.left, top: pos.top }}
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  onRecall();
                }}
                className="block w-full rounded-sharp px-2.5 py-2 text-left transition-colors hover:bg-brand-cream/60 focus-visible:bg-brand-cream/60 focus-visible:outline-none"
              >
                <span className="block text-[12.5px] font-semibold text-brand-navy">{label}</span>
                <span className="mt-0.5 block text-[11px] leading-[1.45] text-ink-muted">{description}</span>
              </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
