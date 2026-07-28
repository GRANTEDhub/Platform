"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, Loader2, ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Staff-only "Check a grant" widget on the client dashboard: drop in a grant name or a
// Grants.gov/Simpler link, confirm the right grant, and get a fit verdict against THIS
// client — the client-first entry to the same single-pair scorer the engine uses.
//
// Two steps, matching the backend: RESOLVE (find candidates in the ledger) -> confirm ->
// SCORE (POST /api/clients/[id]/check-grant). A genuine fit is auto-added to the roadmap;
// a weak/no answer just reports. Confirm-before-score is deliberate — never analyze a
// grant the user didn't confirm.

type Candidate = {
  grantId: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
  status: string;
  ready: boolean;
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

  async function resolve(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || phase === "resolving") return;
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

  return (
    <Card className="mt-6 p-6 shadow-grounded sm:p-7">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Check a grant</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop in a grant name or a Grants.gov / Simpler.gov link to see if {clientName} is a fit.
          </p>
        </div>
        {phase !== "idle" && (
          <Button variant="ghost" size="sm" onClick={reset}>
            <ArrowLeft className="h-3.5 w-3.5" /> New check
          </Button>
        )}
      </div>

      {/* Step 1: input */}
      {(phase === "idle" || phase === "resolving") && (
        <form onSubmit={resolve} className="mt-4 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Grant name, opportunity number, or link…"
            className="flex-1 rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm text-brand-navy outline-none ring-brand-orange/30 focus:ring-2"
          />
          <Button type="submit" disabled={phase === "resolving" || !query.trim()}>
            {phase === "resolving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {phase === "resolving" ? "Searching…" : "Check"}
          </Button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {/* Step 2: confirm a candidate */}
      {phase === "candidates" && (
        <div className="mt-4 space-y-2">
          {candidates.length > 0 && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Confirm the grant to score
            </p>
          )}
          {candidates.map((c) => (
            <button
              key={c.grantId}
              onClick={() => score(c.grantId)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-brand-navy/10 bg-white px-4 py-3 text-left transition hover:border-brand-navy/25"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-brand-navy">{c.title ?? "Untitled grant"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.funder ?? "Unknown funder"}
                  {c.submission_deadline ? ` · due ${c.submission_deadline}` : ""}
                  {!c.ready ? ` · still processing (${c.status})` : ""}
                </p>
              </div>
              <span className="shrink-0 text-xs font-medium text-brand-orange">Check fit →</span>
            </button>
          ))}
          {message && (
            <p className="flex items-start gap-2 rounded-lg bg-brand-navy/[0.04] px-4 py-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
        </div>
      )}

      {/* scoring */}
      {phase === "scoring" && (
        <p className="mt-4 flex items-center gap-2 text-sm text-brand-navy">
          <Loader2 className="h-4 w-4 animate-spin text-brand-orange" /> Scoring fit against {clientName}…
        </p>
      )}

      {/* Step 3: verdict */}
      {phase === "result" && result && <Result result={result} clientId={clientId} />}
    </Card>
  );
}

function Result({ result, clientId }: { result: RunResult; clientId: string }) {
  const meta = VERDICT_META[result.verdict];
  const Icon = meta.icon;
  return (
    <div className="mt-4 space-y-4">
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
          <Link href={`/clients/${clientId}/roadmap`} className="font-medium text-brand-orange hover:underline">
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
