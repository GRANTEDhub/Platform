// The proposal builder's sections: NOFO-shaped instructions plus an example of what the
// section is asking for.
//
// PLACEHOLDER, NOT DRAFT, and that distinction is the whole reason this file exists. The
// example text used to be the section's initial VALUE, which meant every draft opened
// pre-filled with a mobile-health-clinic narrative that a client could save as their own —
// and once stored, "every section is non-empty" would be true for a proposal nobody had
// written a word of. As a placeholder it is visible guidance that cannot be saved, so a
// stored section is authored by construction and draftCompleteness stays honest.
//
// STILL ONE FICTIONAL PROJECT, and still identical for every grant. These are examples of
// the SHAPE of an answer, not content derived from the NOFO in front of the client — step 4
// of the build order replaces them with the grant's own requirements. Until then the copy on
// the page says as much rather than implying a tailored brief.
//
// Extracted here (from build-client) so the ids the editor renders and the ids a save writes
// come from one list. Two copies of this list is how a section quietly stops being counted.

export interface SectionSpec {
  id: string;
  title: string;
  // What the section must contain, in the NOFO's terms.
  instructions: string;
  // An example answer. Rendered as a placeholder; never stored, never saved.
  placeholder: string;
}

export const PROPOSAL_SECTIONS: SectionSpec[] = [
  {
    id: "problem",
    title: "Problem Statement",
    instructions:
      "Required: state the specific need this project addresses, grounded in local data. Recommended: cite a named source for every statistic.",
    placeholder:
      "e.g. Our community faces a critical gap in accessible healthcare services, particularly affecting low-income families and elderly residents who lack reliable transportation.",
  },
  {
    id: "population",
    title: "Target Population",
    instructions:
      "Required: define who is served, with a defensible size estimate. Recommended: break the estimate down by the sub-groups the NOFO prioritizes.",
    placeholder:
      "e.g. Low-income families and elderly residents (65+) within a 5-mile radius of downtown, approximately 2,500 individuals.",
  },
  {
    id: "strategy",
    title: "Proposed Strategy",
    instructions:
      "Required: describe the intervention and how it resolves the stated problem. Recommended: name the evidence base or model it's adapted from.",
    placeholder:
      "e.g. Establish a mobile health clinic that visits underserved neighborhoods three times weekly, providing preventive care, health screenings, and chronic disease management.",
  },
  {
    id: "activities",
    title: "Key Activities",
    instructions:
      "Required: list the concrete activities that deliver the strategy above. Recommended: sequence them against the project timeline.",
    placeholder:
      "e.g. Weekly mobile clinic visits, partnership coordination with local healthcare providers, community health education workshops, and patient follow-up services.",
  },
  {
    id: "goals",
    title: "Goals & Objectives",
    instructions:
      "Required: state measurable objectives (SMART format) tied directly to the problem statement. Recommended: cap it at 3-5 objectives.",
    placeholder:
      "e.g. Increase preventive care access for 2,500 residents by Year 1; reduce avoidable ER visits among enrolled patients by 20% by Year 2.",
  },
  {
    id: "timeline",
    title: "Timeline & Milestones",
    instructions:
      "Required: a phase-by-phase schedule covering the full period of performance. Recommended: flag any milestone dependent on a partner organization.",
    placeholder:
      "e.g. Months 1-3: hire clinical staff, finalize partner MOUs. Months 4-6: launch mobile unit. Months 7-12: scale to full three-day weekly schedule.",
  },
  {
    id: "evaluation",
    title: "Evaluation Plan",
    instructions:
      "Required: describe how outcomes will be measured against the objectives above. Recommended: name the data system used to track them.",
    placeholder:
      "e.g. Patient encounter data tracked via the clinic's EHR system, reported quarterly against the Year 1/Year 2 access and utilization targets.",
  },
  {
    id: "sustainability",
    title: "Sustainability Plan",
    instructions:
      "Required: explain how the program continues after the award period ends. Recommended: name a specific future funding source, not just \"we'll seek grants.\"",
    placeholder:
      "e.g. Continued operation funded through a blended model of Medicaid reimbursement, sliding-scale patient fees, and a committed local hospital system contribution.",
  },
  {
    id: "budget",
    title: "Budget Narrative",
    instructions:
      "Required: justify every major cost category in plain language. Recommended: tie each cost directly back to an activity above.",
    placeholder:
      "e.g. Costs cover a mobile clinic vehicle lease, 2.5 FTE clinical staff, medical supplies, and partner coordination overhead — detailed by category in the attached budget.",
  },
];
