"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PursuitChooser } from "./pursuit-chooser";
import type { CardDecision, PursuitPath } from "@/types/database";

// The shared decision gate on the Grant Report detail. Used by BOTH the client
// portal and the staff account-manager view — the write path (PATCH /api/review/[id])
// records decided_by + decided_by_actor from whoever is signed in, and NEVER sends
// email (outreach lives only in the alert route). The unified decision: Pursue =
// approved · Save for later = pending · Pass = passed. A Pass reason is REQUIRED (see
// the pass box below) and is routed to the match_feedback calibration store server-side
// -- this replaced the standalone agree/flag score-feedback control that used to sit
// beside the decision. Requiring it means every client Pass yields a calibration
// datapoint: the server only records one when a reason is present (no reason -> no
// signal), so an optional field left blank was a silently-dropped training signal on
// the one action -- "this match was wrong" -- that carries the most.
export function DecisionBar({
  cardId,
  decision,
  deciderLabel,
  tier,
  pursuitPath = null,
  showPursuitPath = false,
  intellEngineComingSoon = false,
}: {
  cardId: string;
  decision: CardDecision;
  // "you" / "your GRANTED team" / the client org name — resolved server-side from
  // decided_by_actor. Null when undecided.
  deciderLabel: string | null;
  // Set on the CLIENT portal only: swaps the generic "Pursue" button for the
  // pursuit chooser (IntellEngine / SME / in-house, migration 0061). Save-for-later
  // and Pass are unchanged. Absent on the staff view, which keeps plain Pursue.
  tier?: "premium" | "base";
  // Forwarded to PursuitChooser: whether the IntellEngine path is offered as a LIVE option.
  // Server-resolved from pursuitClientAccessEnabled(); false hides the live option. Defaults false.
  showPursuitPath?: boolean;
  // Forwarded to PursuitChooser: when the live option is off, show it as an inert "COMING SOON"
  // card instead of omitting it (client soft-launch). The chooser only renders when `tier` is set
  // (portal-only), so this never reaches staff. Defaults false.
  intellEngineComingSoon?: boolean;
  pursuitPath?: PursuitPath | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [passReason, setPassReason] = useState("");

  async function decide(next: CardDecision, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: next, decision_reason: reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      setShowPass(false);
      // Client (tier set): a Pass or Save-for-later on the detail is a decision — show
      // the brief "recorded" transition, then land back on the Grant Report to keep
      // reviewing (#18c). Staff keep the in-place refresh.
      if (tier) {
        router.push(`/portal/grants/decided?o=${next}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  const pursuing = decision === "approved";
  const passed = decision === "passed";

  return (
    // Renders inside the fit-score box (bg-brand-chrome) — dark-themed, and no top divider of
    // its own (the ScoreCard already rules off the whole "Your decision" section).
    <div>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          {tier ? (
            <PursuitChooser
              cardId={cardId}
              pursuitPath={pursuitPath}
              tier={tier}
              variant="detail"
              showPursuitPath={showPursuitPath}
              intellEngineComingSoon={intellEngineComingSoon}
            />
          ) : (
            <button
              disabled={busy}
              onClick={() => decide("approved")}
              className={`rounded-full px-6 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${
                pursuing
                  ? "bg-white/[0.12] text-white ring-1 ring-white/25"
                  : "border border-white/25 text-white/85 hover:bg-white/[0.06]"
              }`}
            >
              {pursuing ? "✓ Pursuing" : "Pursue this grant"}
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => decide("pending")}
            className={`rounded-full px-6 py-2.5 text-sm font-medium transition disabled:opacity-50 ${
              decision === "pending"
                ? "bg-white/[0.1] text-white ring-1 ring-white/20"
                : "border border-white/25 text-white/70 hover:text-white"
            }`}
          >
            Save for later
          </button>
          <button
            disabled={busy}
            onClick={() => (passed ? decide("pending") : setShowPass((v) => !v))}
            className={`px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
              passed ? "text-orange-200 underline" : "text-orange-200/80 hover:text-orange-200 hover:underline"
            }`}
          >
            {passed ? "Passed — undo" : "Pass"}
          </button>
        </div>

        {/* Pass reason is REQUIRED: it's the calibration signal (routed to match_feedback
            server-side), and the server records a datapoint only when a reason is present.
            So the confirm button stays disabled until a non-empty reason is entered. */}
        {showPass && !passed && (
          <div className="mt-3 space-y-2 rounded-xl border border-white/[0.12] bg-white/[0.05] p-3">
            <p className="text-xs font-medium text-white/85">
              Why pass? This is how we tune your matches — tell us what&apos;s off and we&apos;ll send fewer like it.
            </p>
            <textarea
              value={passReason}
              onChange={(e) => setPassReason(e.target.value)}
              rows={2}
              autoFocus
              placeholder="e.g. we don't want equipment grants, wrong geography, no capacity this cycle"
              className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-white/45"
            />
            <button
              disabled={busy || !passReason.trim()}
              onClick={() => decide("passed", passReason)}
              className="rounded-full bg-destructive px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Pass on this grant
            </button>
          </div>
        )}

        {deciderLabel && (
          <p className="mt-3 text-[13px] text-white/60">
            {pursuing ? "Pursuing" : passed ? "Passed" : "Saved"} · decided by {deciderLabel}
          </p>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
