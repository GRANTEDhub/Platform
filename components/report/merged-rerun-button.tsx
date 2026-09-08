"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCw } from "lucide-react";
import { BRAND } from "@/lib/brand";

type RerunStatus = "queued" | "processing" | "done" | "error";

// Merged "Re-run grant match" (PR 1) — ONE button replacing the console's separate QA re-run + uses
// re-extract. It POSTs /api/review/[id]/rerun to QUEUE a full background re-run (engine re-match → QA →
// uses) and returns immediately; the intel drain (+ its watchdog) runs it to completion. The "Running…"
// state is SERVER-DERIVED via `initialStatus` (the queue row for this pair), so it survives navigation —
// leave the page and come back and the button still reads "Running…". While running it polls GET for the
// finish, then router.refresh()es so the freshly re-run card renders. Staff-only by mount point.
//
// Styling mirrors the old IntelRerunButton (full-width chrome button + caption) so the IntellEngine box is
// unchanged visually — only the behavior (full re-run, backgrounded) and the single-button layout differ.
const POLL_MS = 6000;
// Stop polling after this long so a wedged job (drain disabled, grant stuck mid-scoring) doesn't spin the
// "Running…" state forever — a full re-run realistically finishes in a few minutes. A reload re-derives
// state from the server, so this is only a client-side cap, not a give-up on the job itself.
const MAX_POLL_MS = 15 * 60 * 1000;

export function MergedRerunButton({
  cardId,
  initialStatus,
  backHref,
}: {
  cardId: string;
  initialStatus: RerunStatus | null;
  backHref: string;
}) {
  const router = useRouter();
  // Running = the server says a job is queued/processing for this pair. Seeded from initialStatus so a
  // reload / navigation re-derives it (the button never owns this truth on its own).
  const [running, setRunning] = useState(initialStatus === "queued" || initialStatus === "processing");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The re-match dropped this card (it no longer qualifies). We must NOT router.refresh() then — the detail
  // page would notFound()/404. Show a "removed" note + a link back to the roadmap instead.
  const [dropped, setDropped] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number | null>(null);
  const inFlight = useRef(false);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // never overlap polls
    // Give up after MAX_POLL_MS so a stuck job never leaves "Running…" spinning forever (a reload re-derives
    // state from the server if it's genuinely still going).
    if (pollStartRef.current && Date.now() - pollStartRef.current > MAX_POLL_MS) {
      stopPoll();
      setRunning(false);
      setNote("Still running in the background — this is taking longer than usual. Reload the page in a bit to see the result.");
      return;
    }
    inFlight.current = true;
    try {
      const res = await fetch(`/api/review/${cardId}/rerun`, { method: "GET" });
      // A non-2xx (session expired, transient 500, admin-check failure) has no usable status — treat it as a
      // transient blip and keep polling, NOT as a finished job (which would falsely show "Re-run complete").
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { status?: RerunStatus | null; cardPresent?: boolean };
      const s = data.status ?? null;
      if (s === "queued" || s === "processing") return; // still going — keep polling
      // Terminal (done / error / gone): stop and reflect it.
      stopPoll();
      setRunning(false);
      if (data.cardPresent === false) {
        // The re-match DROPPED this card — the card row is gone. A router.refresh() here would 404 the
        // detail page (notFound on the missing card), so surface the removal and point back to the roadmap.
        setDropped(true);
      } else if (s === "error") {
        setError("The re-run hit an error. Try again, or check the card.");
      } else {
        setNote("Re-run complete.");
        router.refresh(); // re-render the server card with the fresh match + QA + uses
      }
    } catch {
      // Transient network blip — keep polling; the drain finishes regardless of this read.
    } finally {
      inFlight.current = false;
    }
  }, [cardId, router, stopPoll]);

  // Drive the poll from `running`. setInterval's first fire is at POLL_MS (not immediately), so a POST's
  // enqueue has landed well before the first GET — no "job not found yet → premature done" race.
  useEffect(() => {
    if (running && !pollRef.current) {
      pollStartRef.current = Date.now(); // anchor the give-up window to when polling begins
      pollRef.current = setInterval(() => void poll(), POLL_MS);
    }
    return stopPoll;
  }, [running, poll, stopPoll]);

  async function start() {
    if (running) return; // disable-on-submit (also the disabled button)
    setError(null);
    setNote(null);
    setDropped(false);
    setRunning(true); // optimistic — the poll effect starts watching
    try {
      const res = await fetch(`/api/review/${cardId}/rerun`, { method: "POST" });
      if (!res.ok && res.status !== 202) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Couldn't start the re-run");
      }
      // Queued — the poll effect (running=true) now watches for completion.
    } catch (err) {
      setRunning(false); // the effect cleanup clears the interval before it ever fires
      setError(err instanceof Error ? err.message : "Couldn't start the re-run");
    }
  }

  if (dropped) {
    // The re-match removed the card. Don't offer to re-run a card that no longer exists — say what happened
    // and give the way back. (No router.refresh(): the detail page would 404 on the missing card.)
    return (
      <div className="rounded-sharp border border-black/10 bg-black/[0.02] p-3">
        <p className="text-[12px] leading-[1.5] text-ink-muted">
          The re-run found this grant no longer qualifies for this client, so the card was removed from the
          roadmap. Nothing else to do here.
        </p>
        <Link href={backHref} className="mt-2 inline-flex text-[12px] font-semibold text-ink underline underline-offset-2 hover:opacity-80">
          ← Back to the roadmap
        </Link>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={running}
        onClick={() => void start()}
        className="inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp bg-brand-chrome text-[12.5px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {running ? "Running…" : "Re-run grant match"}
      </button>
      <p className="mt-2 text-[12px] leading-[1.5] text-ink-muted">
        {running
          ? "Re-match, IntellEngine QA, and uses of funds — running in the background. You can leave this page; it keeps going."
          : "Full re-run: engine re-match, IntellEngine QA, and uses of funds."}
      </p>
      {note && <p className="mt-1 text-[11px] text-ink-muted">{note}</p>}
      {error && (
        <p className="mt-1 text-[11px]" style={{ color: BRAND.reject }}>
          {error}
        </p>
      )}
    </div>
  );
}
