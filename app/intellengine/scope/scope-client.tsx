"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, X } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";

const SCOPE_WORD_LIMIT = 500;

type Partner = { name: string; role: string; description: string };

const INITIAL_PARTNERS: Partner[] = [
  {
    name: "Regional Health Network",
    role: "Clinical services partner",
    description: "Provides licensed clinical staff and medical oversight for the mobile unit.",
  },
  {
    name: "County Transit Authority",
    role: "Logistics partner",
    description: "Supplies the vehicle and coordinates weekly route scheduling.",
  },
];

// Step 2 of 3 -- the interactive concept-proposal editor. Lets the client
// adjust the high-level shape (scope, role, partners, budget) before
// IntellEngine drafts the full section-by-section proposal. No screenshot
// existed for this step in the source design, so it's built fresh using the
// same design language as the rest of the flow. Local state only -- nothing
// persists yet, since there's no backend to save it to in this shell pass.
//
// FUTURE WIRING (not built yet -- tracked here per Shannon's note): this
// page's four fields are exactly the four fields the concept-proposal
// generator will eventually produce for a client -- scope of work (<500
// words), estimated budget, the client's role, and partners (named or
// unnamed) with a role + 1-2 sentence description each. Once that generator
// exists, this page should auto-populate from its output instead of the
// hardcoded defaults below, while staying exactly as editable as it is now.
export default function IntellEngineScopeClient() {
  const [scope, setScope] = useState(
    "Establish a mobile health clinic that visits underserved neighborhoods three times weekly, providing preventive care, health screenings, and chronic disease management.",
  );
  const [role, setRole] = useState<"prime" | "partner">("prime");
  const [budget, setBudget] = useState("250,000 - 400,000");
  const [partners, setPartners] = useState<Partner[]>(INITIAL_PARTNERS);
  const [draftPartner, setDraftPartner] = useState({ name: "", role: "", description: "" });

  const scopeWordCount = scope.trim().length ? scope.trim().split(/\s+/).length : 0;
  const overLimit = scopeWordCount > SCOPE_WORD_LIMIT;

  function addPartner() {
    if (!draftPartner.role.trim() && !draftPartner.description.trim()) return;
    setPartners([...partners, { ...draftPartner, name: draftPartner.name.trim() }]);
    setDraftPartner({ name: "", role: "", description: "" });
  }

  return (
    <HubShell variant="texture" width="6xl">
      <Link
        href="/intellengine"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        IntellEngine
      </Link>

      <IntellEngineProgress percent={15} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-4xl space-y-6">
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Project scope of work</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The high-level direction IntellEngine will draft the full proposal from. Adjust freely — you
            can refine individual sections later.
          </p>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={5}
            className="mt-4 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
          <p className={`mt-1.5 text-right text-[11px] ${overLimit ? "font-medium text-destructive" : "text-muted-foreground"}`}>
            {scopeWordCount} / {SCOPE_WORD_LIMIT} words
          </p>
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
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Partners</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Named or unnamed — each with the role they&apos;ll play and a short description of what they do.
          </p>

          {partners.length > 0 && (
            <div className="mt-4 space-y-3">
              {partners.map((p, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-xl border border-brand-navy/10 bg-brand-cream/50 p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-brand-navy">{p.name || "Unnamed partner"}</p>
                    <p className="text-xs font-medium text-brand-orange">{p.role}</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">{p.description}</p>
                  </div>
                  <button
                    onClick={() => setPartners(partners.filter((_, idx) => idx !== i))}
                    aria-label={`Remove ${p.name || "unnamed partner"}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-2 rounded-xl border border-dashed border-brand-navy/15 p-4 sm:grid-cols-2">
            <input
              value={draftPartner.name}
              onChange={(e) => setDraftPartner({ ...draftPartner, name: e.target.value })}
              placeholder="Organization name (optional)"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10 sm:col-span-2"
            />
            <input
              value={draftPartner.role}
              onChange={(e) => setDraftPartner({ ...draftPartner, role: e.target.value })}
              placeholder="Role, e.g. Clinical services partner"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
            <input
              value={draftPartner.description}
              onChange={(e) => setDraftPartner({ ...draftPartner, description: e.target.value })}
              placeholder="1-2 sentences on what they'll do"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
            <button
              onClick={addPartner}
              className="flex w-fit items-center gap-1 rounded-lg border border-brand-navy/15 px-3 py-2 text-sm font-medium text-brand-navy hover:border-brand-navy/30 sm:col-span-2"
            >
              <Plus className="h-4 w-4" />
              Add partner
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <Link
            href="/intellengine/compliance"
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
          >
            Continue to compliance check
          </Link>
        </div>
      </div>
    </HubShell>
  );
}
