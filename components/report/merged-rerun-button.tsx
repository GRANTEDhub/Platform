"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export function MergedRerunButton({
  cardId,
  initialStatus,
}: {
  cardId: string;
  initialStatus: RerunStatus | null;
}) {
  const router = useRouter();
  // Running = the server says a job is queued/processing for this pair. Seeded from initialStatus so a
  // reload / navigation re-derives it (the button never owns this truth on its own).
  const [running, setRunning] = useState(initialStatus === "queued" || initialStatus === "processing");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // never overlap polls
    inFlight.current = true;
    try {
      const res = await fetch(`/api/review/${cardId}/rerun`, { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { status?: RerunStatus | null };
      const s = data.status ?? null;
      if (s === "queued" || s === "processing") return; // still going — keep polling
      // Terminal (done / error / gone): stop and reflect it.
      stopPoll();
      setRunning(false);
      if (s === "error") {
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
      pollRef.current = setInterval(() => void poll(), POLL_MS);
    }
    return stopPoll;
  }, [running, poll, stopPoll]);

  async function start() {
    if (running) return; // disable-on-submit (also the disabled button)
    setError(null);
    setNote(null);
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
