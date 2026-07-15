"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// On-demand "Generate report" trigger + continuation driver for the client/prospect
// dashboard. The client->pool mirror of the grant->roster RematchButton.
//
// The drain stops at a per-round time budget with work left (a big pool needs several
// rounds), so ONE POST can't finish a full match. This component DRIVES it to
// completion: it loops POST /api/clients/[id]/generate-report -> (<=75s per round) ->
// POST again, until the route reports { done: true }, then refreshes so the cards
// render. That's what makes a match complete from a single click with no cron wait and
// no manual SQL -- on preview (no cron) and prod alike.
//
// Recovery (the dead-end this fixes): if a prior drain died and left the record stuck
// 'running', landing on the page AUTO-RESUMES the loop (see the mount effect), so the
// user is never staring at a permanently-disabled "Matching…" with no escape. If a
// round errors, the button becomes an enabled "Resume matching" so there's always a
// manual way forward too.
//
// Concurrency/cost: each round is awaited and sequential (one driver never overlaps
// itself), and the drain's lease (migration 0049) stops this loop, the 10-min cron,
// and a second tab from ever scoring the same pool at once -- so no double LLM spend.
export function GenerateReportButton({
  clientId,
  inProgress,
  confirmRerun,
}: {
  clientId: string;
  inProgress: boolean;
  confirmRerun: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const loopingRef = useRef(false); // guards against two concurrent loops
  const cancelledRef = useRef(false); // set on unmount so the loop stops cleanly

  async function runLoop() {
    if (loopingRef.current) return;
    loopingRef.current = true;
    setPhase("running");
    setError(null);
    try {
      // Backstop against an unbounded loop: even the largest pool with heavy
      // rate-limit backoff finishes well inside this many ~75s rounds. If it's
      // somehow still not 'done' (e.g. a persistent pool-load failure returns 200
      // with no progress), stop and fall back to an enabled "Resume matching" rather
      // than spinning "Matching…" forever.
      const MAX_ROUNDS = 60;
      let rounds = 0;
      while (!cancelledRef.current) {
        if (rounds++ >= MAX_ROUNDS) {
          throw new Error("Matching is taking longer than expected — click Resume to continue.");
        }
        const res = await fetch(`/api/clients/${clientId}/generate-report`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Matching failed to start.");
        }
        const data = (await res.json()) as { done?: boolean };
        if (cancelledRef.current) break;
        router.refresh(); // update the banner count / render cards as they land
        if (data.done) break;
        // Brief pause so a round that did nothing (e.g. the record is briefly leased by
        // another drain) doesn't hammer the route; negligible next to a ~75s scoring round.
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!cancelledRef.current) setPhase("idle");
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Matching failed.");
        setPhase("error"); // -> enabled "Resume matching"
      }
    } finally {
      loopingRef.current = false;
    }
  }

  // Auto-resume on mount when the record is already in flight (queued/running) -- this
  // is what rescues a record stuck 'running' from a prior dead drain. Runs once on true
  // mount; router.refresh() re-renders server components without remounting this client
  // component, so the loop is never double-started.
  useEffect(() => {
    cancelledRef.current = false;
    if (inProgress) void runLoop();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onClick() {
    if (phase === "running" || loopingRef.current) return; // disable-on-submit
    // Confirm only a genuine RE-RUN of an already-matched record (not a plain resume of
    // an in-flight one). Incremental: only grants added since the last run are scored.
    if (confirmRerun && !inProgress) {
      if (
        !window.confirm(
          "Re-run matching for this record against the current grant pool?\n\n" +
            "Only grants added since the last run are scored — existing matches aren't re-scored. " +
            "The current results stay visible under a “refreshing” state until it finishes.",
        )
      ) {
        return;
      }
    }
    void runLoop();
  }

  const busy = phase === "running";
  const label = busy
    ? "Matching…"
    : phase === "error" || inProgress
      ? "Resume matching"
      : "Generate report";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
        <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        {label}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
