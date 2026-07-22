"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CardDecision } from "@/types/database";

// The shared decision gate + score feedback on the Grant Report detail. Used by
// BOTH the client portal and the staff account-manager view — the write path
// (PATCH /api/review/[id]) records decided_by + decided_by_actor from whoever is
// signed in, and NEVER sends email (outreach lives only in the alert route). The
// unified decision: Pursue = approved · Save for later = pending · Pass = passed.
// Laid out as two side-by-side clusters (decision | score feedback).
export function DecisionBar({
  cardId,
  decision,
  deciderLabel,
}: {
  cardId: string;
  decision: CardDecision;
  // "you" / "your GRANTED team" / the client org name — resolved server-side from
  // decided_by_actor. Null when undecided.
  deciderLabel: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [passReason, setPassReason] = useState("");

  const [fb, setFb] = useState<"idle" | "agreed" | "flagged">("idle");
  const [showFlag, setShowFlag] = useState(false);
  const [flagReason, setFlagReason] = useState("");

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
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(agree: boolean, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_card_id: cardId, agree, reason: agree ? undefined : reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't record that");
      setFb(agree ? "agreed" : "flagged");
      setShowFlag(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record that");
    } finally {
      setBusy(false);
    }
  }

  const pursuing = decision === "approved";
  const passed = decision === "passed";

  return (
    <div className="mt-6 border-t border-brand-navy/[0.06] pt-6">
      <div className="grid gap-6 sm:grid-cols-2 sm:gap-8">
        {/* decision */}
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={busy}
              onClick={() => decide("approved")}
              className={`rounded-full px-6 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${
                pursuing
                  ? "bg-brand-navy text-white shadow-soft"
                  : "border border-brand-navy/25 text-brand-navy hover:bg-brand-navy/5"
              }`}
            >
              {pursuing ? "✓ Pursuing" : "Pursue this grant"}
            </button>
            <button
              disabled={busy}
              onClick={() => decide("pending")}
              className={`rounded-full px-6 py-2.5 text-sm font-medium transition disabled:opacity-50 ${
                decision === "pending"
                  ? "bg-brand-navy/[0.07] text-brand-navy ring-1 ring-brand-navy/15"
                  : "border border-brand-navy/25 text-muted-foreground hover:text-brand-navy"
              }`}
            >
              Save for later
            </button>
            <button
              disabled={busy}
              onClick={() => (passed ? decide("pending") : setShowPass((v) => !v))}
              className={`px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
                passed ? "text-destructive underline" : "text-destructive/80 hover:text-destructive hover:underline"
              }`}
            >
              {passed ? "Passed — undo" : "Pass"}
            </button>
          </div>

          {showPass && !passed && (
            <div className="mt-3 space-y-2 rounded-xl border border-brand-navy/10 bg-brand-cream/50 p-3">
              <p className="text-xs font-medium text-brand-navy">Why pass? (helps us tune your matches)</p>
              <textarea
                value={passReason}
                onChange={(e) => setPassReason(e.target.value)}
                rows={2}
                autoFocus
                placeholder="e.g. we don't want equipment grants, wrong geography, no capacity this cycle"
                className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35"
              />
              <button
                disabled={busy}
                onClick={() => decide("passed", passReason)}
                className="rounded-full bg-destructive px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                Pass on this grant
              </button>
            </div>
          )}

          {deciderLabel && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {pursuing ? "Pursuing" : passed ? "Passed" : "Saved"} · decided by {deciderLabel}
            </p>
          )}
        </div>

        {/* score feedback */}
        <div className="sm:border-l sm:border-brand-navy/[0.06] sm:pl-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Agree with the fit score?
          </p>
          {fb === "idle" ? (
            <div className="mt-2.5 flex gap-2">
              <button
                disabled={busy}
                onClick={() => sendFeedback(true)}
                className="rounded-full border border-brand-navy/20 px-4 py-1.5 text-sm font-medium text-brand-navy transition hover:bg-brand-navy/5 disabled:opacity-50"
              >
                👍 Agree
              </button>
              <button
                disabled={busy}
                onClick={() => setShowFlag((v) => !v)}
                className="rounded-full border border-brand-navy/20 px-4 py-1.5 text-sm font-medium text-brand-navy transition hover:bg-brand-navy/5 disabled:opacity-50"
              >
                👎 Flag
              </button>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-muted-foreground">
              {fb === "agreed" ? "Thanks — logged." : "Flagged — logged, we'll factor it into your matches."}
            </p>
          )}

          {showFlag && fb === "idle" && (
            <div className="mt-2.5 space-y-2 rounded-xl border border-brand-navy/10 bg-brand-cream/50 p-3">
              <p className="text-xs font-medium text-brand-navy">What did we get wrong?</p>
              <textarea
                value={flagReason}
                onChange={(e) => setFlagReason(e.target.value)}
                rows={2}
                autoFocus
                placeholder="Eligibility, fit, role, geography — tell us what's off"
                className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35"
              />
              <button
                disabled={busy || !flagReason.trim()}
                onClick={() => sendFeedback(false, flagReason)}
                className="rounded-full bg-brand-navy px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
