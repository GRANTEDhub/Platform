"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";
import type { GrantSummary } from "@/app/api/review/[id]/route";

// Post-decision confirmation, shown as a full-screen overlay on /review/[id]
// after a terminal decision on a CLIENT card. Which state renders depends on ONE
// thing computed server-side: are there remaining pending client cards on this
// grant AFTER this decision (summary.completed), NOT the original match count.
//   State A (completed): result + optional prospecting line, auto-dismiss to Matches.
//   State B (still pending): remaining names + two explicit destinations.
const REDIRECT_MS = 2600;

// The overlay + the draw-on check. Shared by both confirmations below so the release
// case does not carry a second copy of the animation; styled-jsx is scoped to the
// component that renders the markup, so the keyframes have to live in here with the svg.
function ConfirmationShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white px-6 text-center">
      <svg viewBox="0 0 52 52" className="cc-svg" aria-hidden="true">
        <circle className="cc-circle" cx="26" cy="26" r="24" fill="none" />
        <path className="cc-check" fill="none" d="M14 27 l8 8 l16 -16" />
      </svg>

      {children}

      <style jsx>{`
        .cc-svg {
          width: 72px;
          height: 72px;
        }
        .cc-circle {
          stroke: ${BRAND.navy};
          stroke-width: 2;
          stroke-dasharray: 151;
          stroke-dashoffset: 151;
          animation: cc-circle 0.5s ease-out forwards;
        }
        .cc-check {
          stroke: ${BRAND.navy};
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

// RELEASE confirmation, for an account-managed client. A managed send is a release, not a
// terminal decision, so the send route returns grant_summary: null and DecisionConfirmation
// (which would say "decision recorded" and list who is still pending) deliberately does not
// fire. Before this, that left the only successful-send path with no acknowledgement at all:
// the modal closed, the page refreshed in place, and nothing said the client had been
// emailed or moved you off the card you had just finished. Same destination as State A --
// the release IS the end of the work on this card, so it ends the way an approve does.
// doneHref/doneLabel (#8): the console (ReleaseToClientBar) passes the client's Grant Report
// or dashboard so a managed release returns there, not to the cross-client Matches queue.
// Absent on the /review worklist path, where /matches is the correct home.
export function ReleaseConfirmation({
  sent,
  to,
  doneHref,
  doneLabel,
}: {
  sent: boolean;
  to?: string | null;
  doneHref?: string;
  doneLabel?: string;
}) {
  const router = useRouter();
  const dest = doneHref ?? "/matches";
  const destLabel = doneLabel ?? "Matches";

  useEffect(() => {
    const t = setTimeout(() => router.push(dest), REDIRECT_MS);
    return () => clearTimeout(t);
  }, [router, dest]);

  return (
    <ConfirmationShell>
      <div className="mt-8 max-w-md space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900">Released to client</h2>
        {/* Says which of the two actually happened. A blocked/preview send still releases
            the card -- sme_released_at is what puts it in their portal deck -- so
            "released" alone would overstate delivery and "not sent" alone would understate
            the release. */}
        <p className="text-sm text-neutral-600">
          {sent && to ? `Alert emailed to ${to}.` : "Recorded and visible in their portal — email not sent."}
        </p>
        <p className="pt-2 text-xs text-neutral-400">Redirecting to {destLabel}…</p>
      </div>
    </ConfirmationShell>
  );
}

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
    <ConfirmationShell>
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
    </ConfirmationShell>
  );
}
