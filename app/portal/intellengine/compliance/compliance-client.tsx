"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, FileText } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";

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

export default function IntellEngineComplianceClient() {
  const [docs, setDocs] = useState(INITIAL_DOCS);
  const needsUpdate = docs.filter((d) => d.status === "needs_update").length;

  function markVerified(name: string) {
    setDocs((prev) =>
      prev.map((d) => (d.name === name ? { ...d, status: "verified", lastUpdated: "Just now" } : d)),
    );
  }

  return (
    <HubShell variant="texture">
      <Link
        href="/portal/intellengine/scope"
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
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Organization Profile</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            We&apos;ve checked this grant&apos;s required documents against your organization profile. Review
            each item and confirm it&apos;s up to date or upload a new version.
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
            <DocCard key={d.name} doc={d} onVerify={() => markVerified(d.name)} />
          ))}
        </div>

        <div className="flex justify-end">
          <Link
            href="/portal/intellengine/build"
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
          >
            Continue to proposal builder
          </Link>
        </div>
      </div>
    </HubShell>
  );
}

function DocCard({ doc, onVerify }: { doc: Doc; onVerify: () => void }) {
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
          <button
            onClick={() => fileRef.current?.click()}
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-200"
          >
            <AlertTriangle className="h-3 w-3" />
            Update Required
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
            <CheckCircle2 className="h-3 w-3" />
            Verified
          </span>
        )}
      </div>
      {/* Not wired to real storage yet -- selecting a file just simulates the
          document being re-verified, matching the shell scope of this pass. */}
      <input ref={fileRef} type="file" className="hidden" onChange={() => onVerify()} />
    </div>
  );
}
