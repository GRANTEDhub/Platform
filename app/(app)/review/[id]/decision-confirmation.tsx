"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { GrantSummary } from "@/app/api/review/[id]/route";

// Post-decision confirmation, shown as a full-screen overlay on /review/[id]
// after a terminal decision on a CLIENT card. Which state renders depends on ONE
// thing computed server-side: are there remaining pending client cards on this
// grant AFTER this decision (summary.completed), NOT the original match count.
//   State A (completed): result + optional prospecting line, auto-dismiss to Matches.
//   State B (still pending): remaining names + two explicit destinations.
const REDIRECT_MS = 2600;

export function DecisionConfirmation({ summary }: { summary: GrantSummary }) {
  const router = useRouter();

  // State A auto-dismisses; State B waits for the user's click.
  useEffect(() => {
    if (!summary.completed) return;
    const t = setTimeout(() => router.push("/matches"), REDIRECT_MS);
    return () => clearTimeout(t);
  }, [summary.completed, router]);

  const resultLine = (r: GrantSummary["decided_results"][number]) => {
    const name = r.name ?? "Client";
    if (r.decision === "passed") return `${name} — rejected`;
    // Approved: "alerted" ONLY when the email physically sent (sent_at set);
    // otherwise it was recorded but not sent (e.g. sending disabled / preview).
    return r.sent ? `Alerted ${name}` : `${name} — recorded, not sent`;
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white px-6 text-center">
      <svg viewBox="0 0 52 52" className="cc-svg" aria-hidden="true">
        <circle className="cc-circle" cx="26" cy="26" r="24" fill="none" />
        <path className="cc-check" fill="none" d="M14 27 l8 8 l16 -16" />
      </svg>

      {summary.completed ? (
        <div className="mt-8 max-w-md space-y-3">
          <h2 className="text-lg font-semibold text-neutral-900">Grant complete</h2>
          <ul className="space-y-1 text-sm text-neutral-600">
            {summary.decided_results.map((r, i) => (
              <li key={i}>{resultLine(r)}</li>
            ))}
          </ul>
          {summary.prospect_eligible && (
            <p className="text-sm text-neutral-600">Now available for prospecting.</p>
          )}
          <p className="pt-2 text-xs text-neutral-400">Redirecting to Matches…</p>
        </div>
      ) : (
        <div className="mt-8 max-w-md space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900">Decision recorded</h2>
          <p className="text-sm text-neutral-600">
            Still pending on this grant: {summary.remaining_pending.join(", ")}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => router.push(`/grants/${summary.grant_id}`)}>
              Finish this grant
            </Button>
            <Button variant="outline" onClick={() => router.push("/matches")}>
              Back to Matches
            </Button>
          </div>
        </div>
      )}

      <style jsx>{`
        .cc-svg {
          width: 72px;
          height: 72px;
        }
        .cc-circle {
          stroke: #16a34a;
          stroke-width: 2;
          stroke-dasharray: 151;
          stroke-dashoffset: 151;
          animation: cc-circle 0.5s ease-out forwards;
        }
        .cc-check {
          stroke: #16a34a;
          stroke-width: 3;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-dasharray: 40;
          stroke-dashoffset: 40;
          animation: cc-check 0.35s 0.45s ease-out forwards;
        }
        @keyframes cc-circle {
          to {
            stroke-dashoffset: 0;
          }
        }
        @keyframes cc-check {
          to {
            stroke-dashoffset: 0;
          }
        }
      `}</style>
    </div>
  );
}
