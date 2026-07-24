"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Sparkles, RotateCcw, LifeBuoy, CheckCircle2 } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";

const SUPPORT = "support@grantedco.com";

type Section = { id: string; title: string; instructions: string; draft: string };

// Step 3 -- the proposal builder. Each section = NOFO-derived instructions +
// an AI-drafted, editable field + three actions (per the Canva wireframe,
// which is the source of truth for this interaction, not the Figma's plainer
// version):
//   - Edit with GrantBot: a per-proposal chat thread for comments/questions,
//     not built yet (needs the real LLM plumbing -- shows a "coming soon" note).
//   - Regenerate: redraft the section from scratch via the LLM, with tone/
//     direction options ("be more assertive," etc.) -- same, not wired yet.
//   - Ask the experts: a real, working escalation to the client's GRANTED
//     team -- reuses the same support-email pattern as the rest of the portal,
//     no AI dependency, so no reason to fake this one.
const SECTIONS: Section[] = [
  {
    id: "problem",
    title: "Problem Statement",
    instructions:
      "Required: state the specific need this project addresses, grounded in local data. Recommended: cite a named source for every statistic.",
    draft:
      "Our community faces a critical gap in accessible healthcare services, particularly affecting low-income families and elderly residents who lack reliable transportation.",
  },
  {
    id: "population",
    title: "Target Population",
    instructions:
      "Required: define who is served, with a defensible size estimate. Recommended: break the estimate down by the sub-groups the NOFO prioritizes.",
    draft: "Low-income families and elderly residents (65+) within a 5-mile radius of downtown, approximately 2,500 individuals.",
  },
  {
    id: "strategy",
    title: "Proposed Strategy",
    instructions:
      "Required: describe the intervention and how it resolves the stated problem. Recommended: name the evidence base or model it's adapted from.",
    draft:
      "Establish a mobile health clinic that visits underserved neighborhoods three times weekly, providing preventive care, health screenings, and chronic disease management.",
  },
  {
    id: "activities",
    title: "Key Activities",
    instructions:
      "Required: list the concrete activities that deliver the strategy above. Recommended: sequence them against the project timeline.",
    draft:
      "Weekly mobile clinic visits, partnership coordination with local healthcare providers, community health education workshops, and patient follow-up services.",
  },
  {
    id: "goals",
    title: "Goals & Objectives",
    instructions:
      "Required: state measurable objectives (SMART format) tied directly to the problem statement. Recommended: cap it at 3-5 objectives.",
    draft:
      "Increase preventive care access for 2,500 residents by Year 1; reduce avoidable ER visits among enrolled patients by 20% by Year 2.",
  },
  {
    id: "timeline",
    title: "Timeline & Milestones",
    instructions:
      "Required: a phase-by-phase schedule covering the full period of performance. Recommended: flag any milestone dependent on a partner organization.",
    draft:
      "Months 1-3: hire clinical staff, finalize partner MOUs. Months 4-6: launch mobile unit. Months 7-12: scale to full three-day weekly schedule.",
  },
  {
    id: "evaluation",
    title: "Evaluation Plan",
    instructions:
      "Required: describe how outcomes will be measured against the objectives above. Recommended: name the data system used to track them.",
    draft:
      "Patient encounter data tracked via the clinic's EHR system, reported quarterly against the Year 1/Year 2 access and utilization targets.",
  },
  {
    id: "sustainability",
    title: "Sustainability Plan",
    instructions:
      "Required: explain how the program continues after the award period ends. Recommended: name a specific future funding source, not just \"we'll seek grants.\"",
    draft:
      "Continued operation funded through a blended model of Medicaid reimbursement, sliding-scale patient fees, and a committed local hospital system contribution.",
  },
  {
    id: "budget",
    title: "Budget Narrative",
    instructions:
      "Required: justify every major cost category in plain language. Recommended: tie each cost directly back to an activity above.",
    draft:
      "Costs cover a mobile clinic vehicle lease, 2.5 FTE clinical staff, medical supplies, and partner coordination overhead — detailed by category in the attached budget.",
  },
];

export default function IntellEngineBuildClient() {
  const [sections, setSections] = useState(SECTIONS);
  const completed = sections.filter((s) => s.draft.trim().length > 0).length;

  function updateDraft(id: string, value: string) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, draft: value } : s)));
  }

  return (
    <HubShell variant="texture" width="6xl">
      <Link
        href="/portal/intellengine/compliance"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <IntellEngineProgress percent={75} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-3xl space-y-6">
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Project Scope Builder</h2>
            <button className="text-sm font-medium text-brand-orange hover:underline">Change Template</button>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Complete each section of your project scope. All fields have AI assistance available.
          </p>
          <div className="mt-4 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Fields Completed</span>
            <span>
              {completed} of {sections.length}
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-brand-navy/[0.08]">
            <div
              className="h-2 rounded-full bg-brand-navy transition-all"
              style={{ width: `${(completed / sections.length) * 100}%` }}
            />
          </div>
        </div>

        {sections.map((s) => (
          <SectionCard key={s.id} section={s} onChange={(v) => updateDraft(s.id, v)} />
        ))}
      </div>
    </HubShell>
  );
}

function SectionCard({ section, onChange }: { section: Section; onChange: (value: string) => void }) {
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="rounded-2xl bg-white p-6 shadow-grounded">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-[17px] font-semibold text-brand-navy">{section.title}</h3>
        {section.draft.trim().length > 0 && (
          <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-500" />
        )}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{section.instructions}</p>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <textarea
          value={section.draft}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="flex-1 rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
        />
        <div className="flex shrink-0 flex-row gap-2 sm:w-44 sm:flex-col">
          <button
            onClick={() => setNote("GrantBot chat is coming soon — for now, edit the text directly above.")}
            className="flex-1 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            Edit with GrantBot
          </button>
          <button
            onClick={() => setNote("Regenerating is coming soon — this will redraft the section from scratch.")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Regenerate
          </button>
          <a
            href={`mailto:${SUPPORT}?subject=${encodeURIComponent(`Question on "${section.title}" — proposal draft`)}`}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            Ask the experts
          </a>
        </div>
      </div>

      {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}

      <p className="mt-2.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        AI-generated content (you can edit this)
      </p>
    </div>
  );
}
