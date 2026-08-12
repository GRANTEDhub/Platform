"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  FileText,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import type { EligibilityLevel, EligibilityVerdict } from "@/lib/intellengine/eligibility";
import {
  REQUIREMENT_FIELDS,
  REQUIREMENT_FIELD_LABELS,
  hasAnyRequirement,
  type ApplicationRequirements,
} from "@/lib/grants/requirements";

// Step 2.5 -- the eligibility read, the NOFO-derived application-requirements checklist (0081),
// and an honest gap where the document check will go.
//
// WHAT WAS HERE, AND WHY IT IS GONE. Six hardcoded documents ("Annual Audit", "Form 990",
// "Board List" ...) with invented dates, identical for every client and every grant, a
// Verified/Needs-Update tally counting them, and a file input whose onChange threw the file
// away and flipped the row to "Verified - Just now". Every number on the panel was fiction.
//
// WHAT REPLACES THE TALLY. The requirements checklist below -- but it is a grant-level, NOFO-derived
// artifact, quote-grounded and advisory, NOT a per-client status count. It says what THIS grant's
// application must contain (read off the NOFO, every line anchored to a verbatim span), and it
// never claims we have those documents or gates the flow. When the NOFO cannot be read, it says so
// and refuses to infer. Knowing what a grant requires is still not knowing whether a client
// satisfies it, so draftCompleteness keeps compliance `unknown` and this never blocks Continue.
//
// The eligibility card is untouched and remains the SOLE eligibility surface: a real per-client
// read computed server-side from the grant's own NOFO fields. The requirements checklist is
// application mechanics (sections, page limits, attachments, scoring) and deliberately does not
// repeat eligibility, deadlines or cost-share -- those are verified grant fields owned elsewhere.

export default function IntellEngineComplianceClient({
  draftId,
  verdict,
  showRequirements,
  requirements,
  canDerive,
  retrievable,
  attemptsExhausted,
}: {
  draftId?: string;
  verdict: EligibilityVerdict | null;
  showRequirements: boolean;
  requirements: ApplicationRequirements | null;
  canDerive: boolean;
  retrievable: boolean;
  attemptsExhausted: boolean;
}) {
  return (
    <HubShell variant="texture">
      <Link
        href={draftId ? `/intellengine/scope?draft=${draftId}` : "/intellengine/scope"}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <IntellEngineProgress percent={40} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-3xl space-y-6">
        {verdict && <EligibilityCard verdict={verdict} />}

        {showRequirements && (
          <RequirementsCard
            draftId={draftId}
            initial={requirements}
            canDerive={canDerive}
            retrievable={retrievable}
            attemptsExhausted={attemptsExhausted}
          />
        )}

        {/* NO COUNTS, NO STATUSES, NO UPLOAD -- see the note at the top of this file. This card
            states what is and is not built rather than showing a plausible-looking check, and
            it says the step is not a blocker, which matches reality: draftCompleteness reports
            compliance as `unknown`, it is excluded from the percentage, and it never gates
            "ready to submit". */}
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Supporting documents</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            We don&apos;t check your documents against this grant&apos;s requirements yet — so this step
            doesn&apos;t hold you up. Your GRANTED team confirms what&apos;s needed before you apply.
          </p>
          <p className="mt-3 text-[13px] text-muted-foreground">
            Anything you want this proposal to draw from can be attached on the previous step, under
            Supporting files.
          </p>
        </div>

        <div className="flex justify-end">
          <ContinueButton
            draftId={draftId}
            nextHref="/intellengine/build"
            nextStatus="build"
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            Continue to proposal builder
          </ContinueButton>
        </div>
      </div>
    </HubShell>
  );
}

// ── Application requirements (0081) ─────────────────────────────────────────────────────────────
//
// ADVISORY, never gating. Four render states, driven by what the server passed plus one lazy fetch:
//   - a checklist  (an artifact with at least one verified item)
//   - not-retrievable  (the NOFO could not be read; refuses to infer)
//   - nothing-found  (the NOFO was read and states no explicit requirements, or all failed
//     verification)
//   - derive  (staff only, nothing cached yet: a button that triggers the lazy generate route)
function RequirementsCard({
  draftId,
  initial,
  canDerive,
  retrievable,
  attemptsExhausted,
}: {
  draftId?: string;
  initial: ApplicationRequirements | null;
  canDerive: boolean;
  retrievable: boolean;
  attemptsExhausted: boolean;
}) {
  const [reqs, setReqs] = useState<ApplicationRequirements | null>(initial);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function derive() {
    if (!draftId || deriving) return;
    setDeriving(true);
    setError(null);
    try {
      const res = await fetch("/api/intellengine/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId }),
      });
      if (!res.ok) {
        setError("We couldn't read the requirements right now. Try again in a moment.");
        return;
      }
      const data = (await res.json()) as { requirements: ApplicationRequirements | null };
      if (data.requirements) setReqs(data.requirements);
      else setError("No application requirements could be derived from this grant.");
    } catch {
      setError("We couldn't read the requirements right now. Try again in a moment.");
    } finally {
      setDeriving(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-grounded">
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-brand-navy/60" />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">What this application requires</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Read from this grant&apos;s NOFO — every line is quoted from the notice. A guide for scoping
            your proposal, not a final checklist; your GRANTED team confirms what&apos;s needed before you apply.
          </p>
        </div>
      </div>

      <div className="mt-4">
        {reqs && hasAnyRequirement(reqs) ? (
          <RequirementsChecklist reqs={reqs} />
        ) : reqs ? (
          // A stored answer with no items: distinguish "couldn't read the NOFO" from "read it,
          // found nothing explicit."
          <RequirementsNote>
            {reqs.reason === "nofo_not_retrievable"
              ? "We couldn't read this grant's full NOFO, so we haven't derived its application requirements. Your GRANTED team confirms what's needed before you apply."
              : "We didn't find explicit application requirements in this NOFO's text. Your GRANTED team confirms what's needed before you apply."}
          </RequirementsNote>
        ) : !retrievable ? (
          <RequirementsNote>
            The full NOFO for this grant isn&apos;t available to read yet, so we haven&apos;t derived its
            application requirements. Your GRANTED team confirms what&apos;s needed before you apply.
          </RequirementsNote>
        ) : canDerive ? (
          <div>
            <button
              type="button"
              onClick={derive}
              disabled={deriving}
              className="inline-flex items-center gap-2 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-60"
            >
              {deriving && <Loader2 className="h-4 w-4 animate-spin" />}
              {deriving ? "Reading the NOFO…" : "Derive requirements from the NOFO"}
            </button>
            {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
          </div>
        ) : (
          <RequirementsNote>
            {attemptsExhausted
              ? "We couldn't derive this grant's requirements from its NOFO. Your GRANTED team confirms what's needed before you apply."
              : "Your GRANTED team confirms this grant's application requirements before you apply."}
          </RequirementsNote>
        )}
      </div>

      <p className="mt-4 text-[12px] text-brand-navy/55">
        A preliminary read from this grant&apos;s NOFO — not a final determination, and it never blocks
        you from continuing.
      </p>
    </div>
  );
}

function RequirementsNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>;
}

function RequirementsChecklist({ reqs }: { reqs: ApplicationRequirements }) {
  return (
    <dl className="space-y-4 border-t border-brand-navy/10 pt-4">
      {REQUIREMENT_FIELDS.filter((f) => reqs[f].length > 0).map((field) => (
        <div key={field}>
          <dt className="text-[13px] font-semibold text-brand-navy">{REQUIREMENT_FIELD_LABELS[field]}</dt>
          <dd className="mt-1.5">
            <ul className="space-y-2">
              {reqs[field].map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] text-brand-navy/80">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy/40" />
                  <div className="min-w-0">
                    <span>{item.text}</span>
                    {item.quote && (
                      // The verbatim NOFO span this line was verified against -- shown so a reader
                      // who doubts a line can see where it came from.
                      <span className="mt-0.5 block text-[11px] italic text-brand-navy/45">
                        &ldquo;{item.quote}&rdquo;
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The real per-client eligibility read (lib/intellengine/eligibility.ts, computed
// server-side from the grant's NOFO fields). Deliberately advisory: it surfaces a
// verdict + the NOFO's own eligibility facts but NEVER gates the Continue button
// (see the PR #24 lesson -- a blunt block buried eligible nonprofits).
const LEVEL_STYLES: Record<
  EligibilityLevel,
  { label: string; card: string; title: string; iconColor: string; icon: LucideIcon }
> = {
  eligible: { label: "Likely eligible", card: "border-emerald-200 bg-emerald-50", title: "text-emerald-900", iconColor: "text-emerald-600", icon: CheckCircle2 },
  caution: { label: "Confirm eligibility", card: "border-amber-200 bg-amber-50", title: "text-amber-900", iconColor: "text-amber-500", icon: AlertTriangle },
  ineligible: { label: "Eligibility concern", card: "border-red-200 bg-red-50", title: "text-red-900", iconColor: "text-red-600", icon: ShieldAlert },
  unknown: { label: "Eligibility to confirm", card: "border-brand-navy/15 bg-white", title: "text-brand-navy", iconColor: "text-brand-navy/60", icon: Info },
};

function EligibilityCard({ verdict }: { verdict: EligibilityVerdict }) {
  const s = LEVEL_STYLES[verdict.level];
  const Icon = s.icon;
  return (
    <div className={`rounded-2xl border p-6 shadow-grounded ${s.card}`}>
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.iconColor}`} />
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${s.title}`}>Eligibility check — {s.label}</p>
          <p className="mt-0.5 text-[13px] text-brand-navy/80">{verdict.headline}</p>
        </div>
      </div>

      {verdict.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1.5 pl-11 text-[13px] text-brand-navy/75">
          {verdict.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {(verdict.eligibleTypes.length > 0 || verdict.excluded || verdict.geographic) && (
        <dl className="mt-4 space-y-2.5 border-t border-brand-navy/10 pt-4 text-[13px]">
          {verdict.eligibleTypes.length > 0 && (
            <div>
              <dt className="font-medium text-brand-navy">Who can apply (from the NOFO)</dt>
              <dd className="mt-0.5 text-brand-navy/70">{verdict.eligibleTypes.join(" · ")}</dd>
            </div>
          )}
          {verdict.excluded && (
            <div>
              <dt className="font-medium text-brand-navy">Explicitly excluded</dt>
              <dd className="mt-0.5 text-brand-navy/70">{verdict.excluded}</dd>
            </div>
          )}
          {verdict.geographic && (
            <div>
              <dt className="font-medium text-brand-navy">Geographic eligibility</dt>
              <dd className="mt-0.5 text-brand-navy/70">{verdict.geographic}</dd>
            </div>
          )}
        </dl>
      )}

      <p className="mt-4 text-[12px] text-brand-navy/55">
        A preliminary read from this grant&apos;s NOFO — not a final determination. Your GRANTED team confirms
        eligibility before you apply, and this never blocks you from continuing.
      </p>
    </div>
  );
}
