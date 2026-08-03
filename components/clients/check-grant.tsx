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

// The grant stated as facts, straight off the ledger row — see grantFactSummary in
// lib/grants/format.ts. Present on every verdict, including a "no": a reader checking an
// unfamiliar grant needs to know WHAT it is before "not a fit" means anything.
type GrantSummary = {
  description: string | null;
  facts: { label: string; value: string }[];
  focusAreas: string[];
  eligibleEntities: string[];
  sourceUrl: string | null;
  grantStatus: string | null;
};

type RunResult = {
  grant: { id: string; title: string | null; funder: string | null };
  summary?: GrantSummary | null;
  alreadyMatched?: boolean;
  cardId?: string | null;
  persisted: boolean;
  // True when this actor's check never writes anything (a client scoring their own org).
  // Distinct from persisted:false, which for staff means "scored but didn't qualify".
  reportOnly?: boolean;
  verdict: Verdict;
  reason?: string | null;
  // WHY the score is what it is — eligibility read + derivation. The only part of the
  // payload that can explain a NON-fit; why_this_org is a fit's bullets and is empty here.
  rationale?: string | null;
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

export function CheckGrant({
  clientId,
  clientName,
  variant = "console",
}: {
  clientId: string;
  clientName: string;
  // Which actor is holding it. The CARD is identical either way — same 318px rail slot,
  // same field, same overlay — and so is the scoring path. What changes is the outcome
  // wording, because the outcome genuinely differs: staff get a roadmap write on a
  // qualifying fit, a client gets a read. See the reportOnly note in the API route.
  variant?: "console" | "portal";
}) {
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
              className="inline-flex h-[29px] shrink-0 items-center gap-1.5 rounded-sharp bg-brand-orangeFill px-[13px] text-[12.5px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
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
                          {/* The raw pipeline status is ours, not the client's — they get
                              the fact (the read may be thin) without our queue's vocabulary. */}
                          {!c.ready
                            ? variant === "console"
                              ? ` · still processing (${c.status})`
                              : " · still being analyzed"
                            : ""}
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

              {phase === "result" && result && (
                <Result result={result} clientId={clientId} variant={variant} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Result({
  result,
  clientId,
  variant,
}: {
  result: RunResult;
  clientId: string;
  variant: "console" | "portal";
}) {
  const meta = VERDICT_META[result.verdict];
  const Icon = meta.icon;
  // Where the existing card lives for THIS actor. Two different routes to the same card,
  // and a client following the console's /clients/... link would just get a 403.
  const cardHref =
    result.cardId
      ? variant === "portal"
        ? `/portal/grants/${result.cardId}`
        : `/clients/${clientId}/roadmap/${result.cardId}`
      : null;
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
        <p className="text-xs text-muted-foreground">
          {variant === "portal" ? "Already in your Grant Report" : "Already on this client's roadmap"} — showing the
          current read.
          {cardHref && (
            <>
              {" "}
              <Link href={cardHref} className="font-medium text-brand-orangeDeep hover:underline">
                Open it
              </Link>
              .
            </>
          )}
        </p>
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
      {/* Three different facts, and collapsing them would misreport two of them. A client's
          check NEVER writes (reportOnly), which is not the same as a staff check that
          scored and didn't qualify. */}
      {!result.alreadyMatched && !result.persisted && result.verdict !== "excluded" && (
        <p className="text-xs text-muted-foreground">
          {result.reportOnly
            ? "This is a read, not a request — checking a grant here doesn't add it to your Grant Report. Tell your account manager if you want to pursue it."
            : "Not added to the roadmap — surfaced for review only."}
        </p>
      )}

      {/* THE SUMMARY, above the rationale. The grant may be one the reader has never
          opened, and "not a fit" is not an answer until you know what it was not a fit
          for. Facts only — every value is a ledger field, formatted by the same helpers
          the grant pages use. */}
      {result.summary && <Summary summary={result.summary} />}

      {result.why_this_org.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {variant === "portal" ? "Why this fits you" : "Why this org"}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-brand-navy">
            {result.why_this_org.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The fit rationale — the eligibility read plus how the score was derived. On a
          weak or no verdict this is the ONLY thing that explains the answer: why_this_org
          carries a fit's bullets and comes back empty. Header wording follows the verdict
          so the section states its own conclusion. */}
      {result.rationale && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {result.verdict === "fit" ? "Fit rationale" : "Why it doesn't fit"}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm leading-[1.55] text-brand-navy">{result.rationale}</p>
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

// The grant, as facts. A two-column label/value list rather than the grant pages' stat
// tiles: this sits in a 576px modal that already has a verdict banner above it, and four
// tiles plus a description would push the rationale below the fold.
//
// The source link is the last row and is deliberately present on every verdict — the org
// rule is that deadlines and eligibility get verified against the official source, so a
// summary that cannot be checked against one is the wrong shape for this surface.
function Summary({ summary }: { summary: GrantSummary }) {
  return (
    <div className="rounded-lg border border-hairline-strong px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The grant</p>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {summary.facts.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-3 border-b border-hairline pb-1">
            <dt className="shrink-0 text-[11.5px] text-ink-subtle">{f.label}</dt>
            <dd className="min-w-0 truncate text-[12.5px] font-medium text-brand-navy" title={f.value}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {summary.description && (
        <p className="mt-2.5 text-[12.5px] leading-[1.55] text-brand-navy [text-wrap:pretty]">{summary.description}</p>
      )}

      {summary.eligibleEntities.length > 0 && (
        <p className="mt-2 text-[11.5px] text-ink-subtle">
          <span className="font-semibold">Who can apply:</span> {summary.eligibleEntities.join(", ")}
        </p>
      )}
      {summary.focusAreas.length > 0 && (
        <p className="mt-1 text-[11.5px] text-ink-subtle">
          <span className="font-semibold">Focus:</span> {summary.focusAreas.join(", ")}
        </p>
      )}

      {summary.sourceUrl && (
        <a
          href={summary.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-[11.5px] font-semibold text-brand-orangeDeep hover:underline"
        >
          Verify on the official listing →
        </a>
      )}
    </div>
  );
}
