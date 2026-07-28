"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, FileText, Info, ShieldAlert, type LucideIcon } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import type { EligibilityLevel, EligibilityVerdict } from "@/lib/intellengine/eligibility";

type DocStatus = "verified" | "needs_update";
type Doc = { name: string; lastUpdated: string; status: DocStatus };

// Step 2.5 -- the compliance gate. Reads the NOFO to determine which
// documents this grant requires, then checks them against what's already on
// file for the client (verified vs. needs-update). Doc list + statuses are
// hardcoded for this shell pass -- the real version reads the NOFO and the
// client's document repository (lib/storage.ts / client_documents), neither
// of which is wired up yet.
const INITIAL_DOCS: Doc[] = [
  { name: "Annual Audit", lastUpdated: "2026-03-15", status: "verified" },
  { name: "Form 990", lastUpdated: "2026-03-15", status: "verified" },
  { name: "Board List", lastUpdated: "2025-06-20", status: "needs_update" },
  { name: "Operating Budget", lastUpdated: "2026-01-10", status: "verified" },
  { name: "Organization Description", lastUpdated: "2026-02-01", status: "verified" },
  { name: "Mission Statement", lastUpdated: "2026-02-01", status: "verified" },
];

export default function IntellEngineComplianceClient({
  draftId,
  verdict,
}: {
  draftId?: string;
  verdict: EligibilityVerdict | null;
}) {
  const [docs, setDocs] = useState(INITIAL_DOCS);
  const needsUpdate = docs.filter((d) => d.status === "needs_update").length;

  // bumpDate distinguishes the two ways a doc gets cleared: uploading a new
  // version really did just change (lastUpdated -> "Just now"), but confirming
  // an existing doc as still current asserts the OPPOSITE -- nothing changed,
  // so the original date must be preserved, not overwritten.
  function markVerified(name: string, bumpDate: boolean) {
    setDocs((prev) =>
      prev.map((d) => (d.name === name ? { ...d, status: "verified", lastUpdated: bumpDate ? "Just now" : d.lastUpdated } : d)),
    );
  }

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

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Organization Profile</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            IntellEngine is in preview, so this is an example of the documents a grant like this
            typically requires — not yet a real check against your organization&apos;s actual profile.
          </p>
          <div className="mt-4 flex items-center gap-5 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Verified: {docs.length - needsUpdate}
            </span>
            <span className="flex items-center gap-1.5 font-medium text-amber-700">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              Needs Update: {needsUpdate}
            </span>
          </div>
        </div>

        {needsUpdate > 0 && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <p className="text-sm font-semibold text-amber-900">Updates Recommended</p>
              <p className="mt-0.5 text-[13px] text-amber-800">
                {needsUpdate} item{needsUpdate === 1 ? "" : "s"} need{needsUpdate === 1 ? "s" : ""} to be
                reviewed. Click on each item to confirm or upload updated documents.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {docs.map((d) => (
            <DocCard key={d.name} doc={d} onVerify={(bumpDate) => markVerified(d.name, bumpDate)} />
          ))}
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

function DocCard({ doc, onVerify }: { doc: Doc; onVerify: (bumpDate: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const needsUpdate = doc.status === "needs_update";

  return (
    <div
      className={`rounded-2xl border p-4 ${
        needsUpdate ? "border-amber-300 bg-amber-50/40" : "border-brand-navy/[0.06] bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-brand-navy">{doc.name}</p>
            <p className="text-xs text-muted-foreground">Last updated: {doc.lastUpdated}</p>
          </div>
        </div>
        {needsUpdate ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => onVerify(false)}
              className="rounded-full border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Confirm current
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-200"
            >
              <AlertTriangle className="h-3 w-3" />
              Update Required
            </button>
          </div>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
            <CheckCircle2 className="h-3 w-3" />
            Verified
          </span>
        )}
      </div>
      {/* Not wired to real storage yet -- selecting a file just simulates the
          document being re-verified, matching the shell scope of this pass. */}
      <input ref={fileRef} type="file" className="hidden" onChange={() => onVerify(true)} />
    </div>
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
