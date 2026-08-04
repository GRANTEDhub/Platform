"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { useOverdueGate, type OverdueGateConfig } from "./overdue-gate";

// "Your decision" — staff's Gate-2 control for an account-managed client (0059), and the
// terminal act of the grant review screen. The call here is "release to the client", not
// a pursue decision: the client makes that later, on their own copy of this page.
//
// ONE FULL-WIDTH PRIMARY. This was a split button while there were two ways to release;
// with one, the chevron would have opened a menu of a single item. Reject sits below as a
// full-width secondary — routine and reversible, so it is bordered rather than filled, and
// it is not the shadcn destructive red (see BRAND.reject).
//
// ONE WAY TO NOTIFY, and it used to be two. "Send alert" (the PDF) and "Send email" (a
// custom note) were a split button, on the premise that they differed in what landed in
// the inbox. They stopped differing: once the note path also attached the one-pager, the
// only real distinction left was its default copy -- while the alert composer had an
// editable To, subject and body all along. So the choice was between two spellings of the
// same action, and the note path was the one that did NOT write the durable send record,
// which meant the "Alerted" badge, the sent-card re-send guard and recall's "client was
// emailed on <date>" line were all silently wrong depending on which button you pressed.
//
// Releasing sets sme_released_at (the card moves to the client's Grant Alerts) and does
// NOT approve -- the client still decides pursuit. Reject is terminal (decision='passed').
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
  const [mode, setMode] = useState<null | "alert">(null);
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
      // recall button in place if they would rather not.
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
        {recalledDraft && (
          <p className="mt-2 text-[11.5px] leading-[1.5] text-ink-muted">
            The attached {recalledDraft === "complete" ? "completed" : recalledDraft} proposal draft was
            deleted with it.
          </p>
        )}
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
            {draftBlock && (
              // Names the draft's STAGE on purpose. Deleting a completed proposal is a
              // different decision from deleting a scoping stub, and neither can be undone
              // — a confirm that hides which one you have is one people click through.
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
        Release to the client&apos;s Grant Alerts with the one-page PDF — edit the note before it goes — or reject to
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
    </section>
  );
}
