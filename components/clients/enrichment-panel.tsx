"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  PENDING_GRACE_MS,
  type EnrichmentStep,
  type EnrichmentStepState,
} from "@/lib/clients/enrichment-status";

// The post-create enrichment view, in two modes:
//
//   mode="ceremony"  the first-run screen. Polls real status and reveals each step
//                    as it actually lands, then offers the confirm action.
//   mode="tab"       the persistent "API data" view on the client. Same step list,
//                    no polling, no confirm -- just what's on file and a re-run.
//
// HONEST BY CONSTRUCTION. Every line is driven by an artifact that exists on the
// client row; nothing advances on a timer. The previous create screen cycled four
// hard-coded phrases on a 1600ms interval while the real chain ran fire-and-forget
// AFTER the response -- so it narrated work that had not happened yet and could not
// report a failure. This replaces that with observed state.
//
// The one thing status cannot distinguish is "still running" from "ran and failed":
// both leave the artifact absent. So a step that is still pending after
// PENDING_GRACE_MS is reported as "No result yet" with a re-run, NOT as a spinner
// that never stops. Silence is never rendered as progress.

const POLL_MS = 2500;

export function EnrichmentPanel({
  clientId,
  kindLabel,
  initialSteps,
  mode,
  editHref,
  dashboardHref,
}: {
  clientId: string;
  kindLabel: string;
  initialSteps: EnrichmentStep[];
  mode: "ceremony" | "tab";
  editHref: string;
  dashboardHref: string;
}) {
  const [steps, setSteps] = useState(initialSteps);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Elapsed time is what separates "working" from "no result yet". Anchored on
  // mount rather than on the record's creation time: this measures how long WE have
  // been watching, which is the only claim the UI can honestly make.
  const startedAt = useRef<number>(Date.now());
  const [graceExpired, setGraceExpired] = useState(false);

  const pending = steps.filter((s) => s.state === "pending");
  const settled = pending.length === 0;
  const attention = steps.filter((s) => s.state === "needs_input");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/enrichment`, { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      if (Array.isArray(d.steps)) setSteps(d.steps as EnrichmentStep[]);
    } catch {
      // A dropped poll is not worth surfacing -- the next one recovers. A genuinely
      // stuck step still ends up reported via the grace-period path.
    }
  }, [clientId]);

  // Poll only in ceremony mode, and only while something is actually pending.
  useEffect(() => {
    if (mode !== "ceremony" || settled) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [mode, settled, load]);

  useEffect(() => {
    if (mode !== "ceremony" || settled) return;
    const remaining = PENDING_GRACE_MS - (Date.now() - startedAt.current);
    const t = setTimeout(() => setGraceExpired(true), Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [mode, settled]);

  async function rerun() {
    setRerunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/enrichment`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Couldn't re-run the pulls.");
      if (Array.isArray(d.steps)) setSteps(d.steps as EnrichmentStep[]);
      // A completed re-run is a fresh observation window.
      startedAt.current = Date.now();
      setGraceExpired(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't re-run the pulls.");
    } finally {
      setRerunning(false);
    }
  }

  return (
    <div className="space-y-6">
      {mode === "ceremony" && (
        <div>
          <h1 className="font-serif text-2xl font-semibold text-brand-navy">
            {settled ? `Here's what we pulled` : `Pulling public data`}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {settled
              ? `Confirm this looks right before the ${kindLabel} goes into matching. Anything wrong or missing is editable.`
              : `The ${kindLabel} is saved. These run against public sources — each line updates when its result actually lands.`}
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {steps.map((s) => (
          <StepRow key={s.key} step={s} graceExpired={graceExpired} editHref={editHref} />
        ))}
      </ul>

      {attention.length > 0 && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="font-medium">
            {attention.length} pull{attention.length === 1 ? "" : "s"} need{attention.length === 1 ? "s" : ""} a
            value from you.
          </p>
          <p className="mt-0.5 text-xs">
            These aren&apos;t failures — the lookup refuses a guess rather than attaching the wrong
            organization&apos;s numbers. Add the field and re-run.
          </p>
          <Link href={editHref} className="mt-2 inline-block text-xs font-medium underline">
            Edit the {kindLabel} →
          </Link>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={rerun} disabled={rerunning}>
          {rerunning ? "Re-running…" : "Re-run the pulls"}
        </Button>
        {mode === "ceremony" && (
          <Link href={dashboardHref} className={buttonVariants()}>
            {settled ? "Looks right — continue" : "Skip ahead"}
          </Link>
        )}
        <span className="text-xs text-muted-foreground">
          {rerunning
            ? "Running each pull now and waiting for the real result."
            : settled
              ? "Nothing here blocks matching — these add context and citations."
              : "You can continue now; these finish in the background either way."}
        </span>
      </div>
    </div>
  );
}

function StepRow({
  step,
  graceExpired,
  editHref,
}: {
  step: EnrichmentStep;
  graceExpired: boolean;
  editHref: string;
}) {
  // A pending step past the grace period is reported as an unknown outcome, not as
  // continuing progress -- the distinction the derivation cannot make, made here.
  const unresolved = step.state === "pending" && graceExpired;
  const state: EnrichmentStepState | "unknown" = unresolved ? "unknown" : step.state;

  const meta: Record<string, { icon: string; cls: string; note: string | null }> = {
    done: { icon: "✓", cls: "text-emerald-700 bg-emerald-50 ring-emerald-200", note: null },
    skipped: { icon: "–", cls: "text-neutral-600 bg-neutral-50 ring-neutral-200", note: "Not applicable" },
    needs_input: { icon: "!", cls: "text-amber-800 bg-amber-50 ring-amber-200", note: "Needs a value" },
    pending: { icon: "…", cls: "text-brand-navy bg-brand-orange/10 ring-brand-orange/30", note: "Working" },
    unknown: { icon: "?", cls: "text-neutral-700 bg-neutral-50 ring-neutral-200", note: "No result yet" },
  };
  const m = meta[state];

  return (
    <li className="flex items-start gap-3 rounded-xl border border-input bg-card px-4 py-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ${m.cls}`}
      >
        {m.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-brand-navy">
          {step.label}
          {m.note && <span className="ml-2 text-xs font-normal text-muted-foreground">{m.note}</span>}
        </p>
        <p className="text-xs text-muted-foreground">{step.source}</p>
        {step.detail && <p className="mt-1 text-sm">{step.detail}</p>}
        {state === "unknown" && (
          <p className="mt-1 text-sm text-muted-foreground">
            This didn&apos;t report back in time. It may still be running in the background — re-run to
            get a definite answer.
          </p>
        )}
        {step.state === "needs_input" && step.resolveField && (
          <Link href={editHref} className="mt-1 inline-block text-xs font-medium underline">
            Add {step.resolveField === "ein" ? "the EIN" : "the county"} →
          </Link>
        )}
      </div>
    </li>
  );
}
