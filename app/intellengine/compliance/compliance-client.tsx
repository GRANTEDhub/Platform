"use client";

import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, Info, ShieldAlert, type LucideIcon } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import type { EligibilityLevel, EligibilityVerdict } from "@/lib/intellengine/eligibility";

// Step 2.5 -- the eligibility read, and an honest gap where the document check will go.
//
// WHAT WAS HERE, AND WHY IT IS GONE. Six hardcoded documents ("Annual Audit", "Form 990",
// "Board List" ...) with invented dates, identical for every client and every grant, a
// Verified/Needs-Update tally counting them, and a file input whose onChange threw the file
// away and flipped the row to "Verified - Just now". A client could upload their real audit
// and be shown a green check for a file that was never received, about a requirement no NOFO
// had asked for. Every number on the panel was fiction.
//
// NOTHING REPLACES THE TALLY, deliberately. A count needs a denominator, and the denominator
// is "what THIS grant requires", which is step 4's job -- reading requirements out of the
// NOFO. Inventing a plausible-looking one is exactly what was wrong before.
//
// The real content arrives with document assimilation: upload -> extract -> a human reviews
// the proposed profile changes -> commit. This step will then show what we actually know
// about the organization and where it came from. Until then it says so, and says it does not
// block anything -- which is true, and checkable.
//
// The eligibility card below is untouched: it is a real per-client read computed server-side
// from the grant's own NOFO fields, and it was never part of the fabrication.

export default function IntellEngineComplianceClient({
  draftId,
  verdict,
}: {
  draftId?: string;
  verdict: EligibilityVerdict | null;
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
