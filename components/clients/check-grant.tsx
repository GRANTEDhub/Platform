"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Link2, X, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { STAGE, SURFACE } from "@/lib/brand";

// Staff-only "Check a grant" widget on the client dashboard: drop in a grant name or a
// Grants.gov/Simpler link, confirm the right grant, and get a fit verdict against THIS
// client — the client-first entry to the same single-pair scorer the engine uses.
//
// Two steps, matching the backend: RESOLVE (find candidates in the ledger) -> confirm ->
// SCORE (POST /api/clients/[id]/check-grant). A genuine fit is auto-added to the roadmap;
// a weak/no answer just reports. Confirm-before-score is deliberate — never analyze a
// grant the user didn't confirm.
//
// AT REST IT IS A COMPACT RAIL CARD, and everything past the first keystroke happens in an
// OVERLAY. This is a layout constraint, not a preference: the card lives in a 318px rail
// that has to end level with the left column for the page to fit 1440x900 without
// scrolling, and a card that grows to hold candidate lists and a full verdict would break
// that every time it was used. It also used to be the loudest element on the page for a
// tool that is not daily-use.
//
// The overlay is a real modal (backdrop, Escape, click-outside) rather than a popover
// because the verdict is long-form — why-this-org, concept, caveats — and a 318px-anchored
// popover would either clip it or run off-screen.

type Candidate = {
  grantId: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
  status: string;
  ready: boolean;
  reason?: string | null; // why it matched the described need (need-out path)
  onRoadmap?: boolean; // already matched to this client
};

type Verdict = "fit" | "weak" | "no" | "excluded";

type RunResult = {
  grant: { id: string; title: string | null; funder: string | null };
  alreadyMatched?: boolean;
  persisted: boolean;
  verdict: Verdict;
  reason?: string | null;
  fit_score: number;
  proposed_role?: string | null;
  recommended_prime?: string | null;
  why_this_org: string[];
  concept_synopsis?: string | null;
  before_you_approve: string[];
  inferred_fields: string[];
  disqualified: boolean;
  suppressed: boolean;
  outreach_track?: string | null;
};

const VERDICT_META: Record<Verdict, { label: string; icon: typeof CheckCircle2; ring: string; text: string }> = {
  fit: { label: "Strong fit", icon: CheckCircle2, ring: "ring-brand-orange/40 bg-brand-orange/10", text: "text-brand-navy" },
  weak: { label: "Weak fit", icon: AlertTriangle, ring: "ring-amber-400/40 bg-amber-50", text: "text-amber-900" },
  no: { label: "Not a fit", icon: XCircle, ring: "ring-destructive/30 bg-destructive/5", text: "text-destructive" },
  excluded: { label: "Excluded", icon: XCircle, ring: "ring-destructive/30 bg-destructive/5", text: "text-destructive" },
};

export function CheckGrant({ clientId, clientName }: { clientId: string; clientName: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<"idle" | "resolving" | "candidates" | "scoring" | "result">("idle");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function resolve(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (phase === "resolving") return;
    // Nothing typed: put the cursor where the work starts rather than doing nothing.
    // The button stays live for the same reason -- see its disabled note.
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    setPhase("resolving");
    setError(null);
    setMessage(null);
    setCandidates([]);
    setResult(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/check-grant/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't search the ledger.");
      setCandidates(data.candidates ?? []);
      setMessage(data.message ?? null);
      setPhase("candidates");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
      setPhase("idle");
    }
  }

  async function score(grantId: string) {
    setPhase("scoring");
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/check-grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Scoring failed.");
      setResult(data as RunResult);
      setPhase("result");
      if (data.persisted) router.refresh(); // a new card landed -> update dashboard counts
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scoring failed.");
      setPhase("candidates");
    }
  }

  function reset() {
    setPhase("idle");
    setCandidates([]);
    setMessage(null);
    setResult(null);
    setError(null);
    setQuery("");
  }

  // The overlay owns every phase past the input. `resolving` deliberately stays on the
  // card (the button spins) so a fast search does not flash a modal open and shut.
  const open = phase === "candidates" || phase === "scoring" || phase === "result";

  // Cmd/Ctrl-/ focuses the field from anywhere on the page, as the design's hint chip
  // promises. Registered on the window rather than the card because the whole point of
  // advertising a shortcut is that you do not have to reach the control first.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && open) reset();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <section
        className="shrink-0 rounded-sharp border border-edge bg-white px-[18px] pb-3.5 pt-3"
        style={{ borderLeftWidth: "3px", borderLeftColor: STAGE.triage.color }}
      >
        <div className="flex items-center justify-between gap-2.5">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Score a grant</h2>
          <span
            aria-hidden="true"
            className="rounded border border-edge px-[5px] py-px font-mono text-[11px] text-ink-muted"
          >
            ⌘/
          </span>
        </div>

        <form onSubmit={resolve} className="mt-2.5">
          <label className="sr-only" htmlFor="score-a-grant">
            Paste a NOFO link or name a program
          </label>
          <div
            className="flex h-9 items-center gap-2 rounded-sharp border border-edge px-[11px] focus-within:border-brand-orange/60"
            style={{ backgroundColor: SURFACE.sunken }}
          >
            <Link2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <input
              id="score-a-grant"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Paste a NOFO link or name a program"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-brand-navy outline-none placeholder:text-ink-faint"
            />
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2.5">
            <p className="min-w-0 truncate text-[11px] text-ink-subtle">Fit checked against {clientName}</p>
            <button
              type="submit"
              // Disabled ONLY while a check is in flight. It used to also disable on an
              // empty field, which meant the primary sat dimmed at rest on every visit --
              // an enabled control that looks broken. Pressing it with nothing typed now
              // focuses the field, which is the actual next step.
              disabled={phase === "resolving"}
              className="inline-flex h-[29px] shrink-0 items-center gap-1.5 rounded-sharp bg-brand-orange px-[13px] text-[12.5px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
            >
              {phase === "resolving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {phase === "resolving" ? "Checking…" : "Check fit"}
            </button>
          </div>
        </form>

        {/* A resolve failure returns to idle, so its message belongs on the card — there is
            no overlay open to carry it. */}
        {error && !open && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}
      </section>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
          <button
            type="button"
            aria-label="Close"
            onClick={reset}
            className="fixed inset-0 cursor-default bg-brand-navy/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Grant fit check"
            className="relative z-10 my-auto w-full max-w-xl rounded-2xl bg-white shadow-overlay"
          >
            <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-3.5">
              <div className="min-w-0">
                <h3 className="font-serif text-[16px] font-bold text-brand-navy">
                  {phase === "result" ? "Fit check" : "Confirm the grant to score"}
                </h3>
                <p className="mt-0.5 truncate text-[11.5px] text-ink-subtle">Against {clientName}</p>
              </div>
              <button
                type="button"
                onClick={reset}
                aria-label="Close"
                className="-mr-1 shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
              {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

              {phase === "candidates" && (
                <div className="space-y-2">
                  {candidates.map((c) => (
                    <button
                      key={c.grantId}
                      onClick={() => score(c.grantId)}
                      className="flex w-full items-center justify-between gap-4 rounded-md border border-hairline-strong bg-white px-4 py-3 text-left transition-colors hover:border-brand-navy/25"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-brand-navy">{c.title ?? "Untitled grant"}</p>
                          {c.onRoadmap && (
                            <span className="shrink-0 rounded-full bg-brand-navy/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-navy">
                              On roadmap
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-ink-subtle">
                          {c.funder ?? "Unknown funder"}
                          {c.submission_deadline ? ` · due ${c.submission_deadline}` : ""}
                          {!c.ready ? ` · still processing (${c.status})` : ""}
                        </p>
                        {c.reason && <p className="mt-1 text-xs text-brand-navy/70">{c.reason}</p>}
                      </div>
                      <span className="shrink-0 text-xs font-semibold text-brand-orangeDeep">Check fit →</span>
                    </button>
                  ))}
                  {message && (
                    <p className="flex items-start gap-2 rounded-md bg-brand-navy/[0.04] px-4 py-3 text-sm text-ink-muted">
                      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {message}
                    </p>
                  )}
                </div>
              )}

              {phase === "scoring" && (
                <p className="flex items-center gap-2 text-sm text-brand-navy">
                  <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden="true" /> Scoring fit against{" "}
                  {clientName}…
                </p>
              )}

              {phase === "result" && result && <Result result={result} clientId={clientId} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Result({ result, clientId }: { result: RunResult; clientId: string }) {
  const meta = VERDICT_META[result.verdict];
  const Icon = meta.icon;
  return (
    <div className="space-y-4">
      <div className={`flex items-start gap-3 rounded-xl px-4 py-3 ring-1 ${meta.ring}`}>
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${meta.text}`} />
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${meta.text}`}>
            {meta.label}
            {result.verdict !== "excluded" && ` · fit ${result.fit_score}/3`}
            {result.proposed_role ? ` · ${result.proposed_role}` : ""}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {result.grant.title ?? "grant"}
            {result.grant.funder ? ` — ${result.grant.funder}` : ""}
          </p>
          {result.reason && <p className={`mt-1 text-sm ${meta.text}`}>{result.reason}</p>}
          {result.recommended_prime && (
            <p className="mt-1 text-xs text-muted-foreground">Recommended prime: {result.recommended_prime}</p>
          )}
        </div>
      </div>

      {result.alreadyMatched && (
        <p className="text-xs text-muted-foreground">Already on this client&apos;s roadmap — showing the current read.</p>
      )}
      {!result.alreadyMatched && result.persisted && (
        <p className="text-sm text-brand-navy">
          Added to{" "}
          <Link href={`/clients/${clientId}/roadmap`} className="font-medium text-brand-orangeDeep hover:underline">
            the roadmap
          </Link>
          .
        </p>
      )}
      {!result.alreadyMatched && !result.persisted && result.verdict !== "excluded" && (
        <p className="text-xs text-muted-foreground">Not added to the roadmap — surfaced for review only.</p>
      )}

      {result.why_this_org.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why this org</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-brand-navy">
            {result.why_this_org.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {result.concept_synopsis && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Concept</p>
          <p className="mt-1 text-sm text-brand-navy">{result.concept_synopsis}</p>
        </div>
      )}

      {result.before_you_approve.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-amber-400/30">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-900">Before you rely on this</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {result.before_you_approve.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {result.inferred_fields.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Inferred (verify): {result.inferred_fields.join(", ")}
        </p>
      )}
    </div>
  );
}
