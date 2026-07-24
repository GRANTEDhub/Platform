"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, X } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";

// Step 2 of 3 -- the interactive concept-proposal editor. Lets the client
// adjust the high-level shape (scope, role, partners, budget) before
// IntellEngine drafts the full section-by-section proposal. No screenshot
// existed for this step in the source design, so it's built fresh using the
// same design language as the rest of the flow. Local state only -- nothing
// persists yet, since there's no backend to save it to in this shell pass.
export default function IntellEngineScopeClient() {
  const [scope, setScope] = useState(
    "Establish a mobile health clinic that visits underserved neighborhoods three times weekly, providing preventive care, health screenings, and chronic disease management.",
  );
  const [role, setRole] = useState<"prime" | "partner">("prime");
  const [budget, setBudget] = useState("250,000 - 400,000");
  const [partners, setPartners] = useState<string[]>(["Regional Health Network", "County Transit Authority"]);
  const [draftPartner, setDraftPartner] = useState("");

  function addPartner() {
    const v = draftPartner.trim();
    if (v && !partners.includes(v)) setPartners([...partners, v]);
    setDraftPartner("");
  }

  return (
    <HubShell variant="texture">
      <Link
        href="/portal/intellengine"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        IntellEngine
      </Link>

      <IntellEngineProgress percent={15} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-2xl space-y-6">
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Project scope</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The high-level direction IntellEngine will draft the full proposal from. Adjust freely — you
            can refine individual sections later.
          </p>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={4}
            className="mt-4 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Your role</h2>
          <div className="mt-3 flex gap-3">
            {(["prime", "partner"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-full px-4 py-2 text-sm font-medium capitalize transition ${
                  role === r
                    ? "bg-brand-navy text-white"
                    : "border border-brand-navy/15 text-muted-foreground hover:border-brand-navy/30 hover:text-brand-navy"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Estimated budget</h2>
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="mt-3 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Consortium partners</h2>
          {partners.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {partners.map((p, i) => (
                <span
                  key={`${p}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-cream px-3 py-1.5 text-sm text-brand-navy"
                >
                  {p}
                  <button
                    onClick={() => setPartners(partners.filter((_, idx) => idx !== i))}
                    aria-label={`Remove ${p}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <input
              value={draftPartner}
              onChange={(e) => setDraftPartner(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPartner();
                }
              }}
              placeholder="Add a partner organization…"
              className="flex-1 rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
            <button
              onClick={addPartner}
              className="flex items-center gap-1 rounded-xl border border-brand-navy/15 px-3 text-sm font-medium text-brand-navy hover:border-brand-navy/30"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <Link
            href="/portal/intellengine/compliance"
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
          >
            Continue to compliance check
          </Link>
        </div>
      </div>
    </HubShell>
  );
}
