// GRANTED engagement-letter templates, ported from the GOH contract generator to
// a parameterized PLAIN-TEXT builder. Chunk 1 records the signature against this
// exact text (stored as contracts.body_snapshot, immutable). Chunk 2 renders the
// styled/signed PDF -- the wording lives here so both chunks share one source.
//
// Terms are faithful to the GOH engagement letter (AR governing law, Benton
// County venue, disclaimer of warranty, confidentiality, ownership, etc.).

export type TemplateKey = "navigate" | "navigate_plus" | "flex" | "custom";

export interface TemplateMeta {
  key: TemplateKey;
  name: string;
  defaultAmountCents: number | null; // null = admin must enter (custom)
  term: string;
  scope: string[]; // Exhibit A bullet lines
}

export const CONTRACT_TEMPLATES: Record<TemplateKey, TemplateMeta> = {
  navigate: {
    key: "navigate",
    name: "NAVIGATE",
    defaultAmountCents: 500_000,
    term: "Upon delivery of product and review",
    scope: [
      "Intake and Profile Creation: intake survey and/or a 30-minute kickoff call to build a detailed client profile and document repository.",
      "GRANTED Roadmap: a focused list of high-impact Active or Forecasted grants, delivered within thirty (30) days of payment received and confirmed.",
      "Roadmap Review: a one (1) hour meeting to review priority grants and strategize pursuit, within thirty (30) days of Roadmap delivery.",
      "No ongoing, subscription, or recurring services unless expressly stated in writing.",
    ],
  },
  navigate_plus: {
    key: "navigate_plus",
    name: "NAVIGATE+",
    defaultAmountCents: 1_000_000,
    term: "12 months",
    scope: [
      "Everything in NAVIGATE (intake & profile, GRANTED Roadmap, Roadmap Review).",
      "Ongoing Active Monitoring: up to 2 hours per calendar month of proactive research/analysis, with grant alerts on priority-mapped and newly-surfaced in-scope grants.",
      "Beyond the monthly allocation, ad hoc work continues at $150/hour subject to Client approval; grant writing and management projects quoted case-by-case.",
    ],
  },
  flex: {
    key: "flex",
    name: "FLEX",
    defaultAmountCents: 100_000,
    term: "12 months",
    scope: [
      "Flexible Credits applied toward supportive services at $150/hour in 0.25-hour increments until exhausted.",
      "Eligible work: grant writing, fractional advisory, grant management, and research/opportunity identification.",
      "On exhaustion of credits, Provider notifies Client; further work continues ad hoc at $150/hour subject to Client approval.",
    ],
  },
  custom: {
    key: "custom",
    name: "Custom",
    defaultAmountCents: null,
    term: "As agreed",
    scope: ["Scope of work as separately agreed between Client and Provider."],
  },
};

export function isTemplateKey(k: string): k is TemplateKey {
  return k in CONTRACT_TEMPLATES;
}

export function formatAmount(cents: number | null | undefined): string {
  if (cents == null) return "As quoted";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
}

const COMMON_TERMS = [
  "Client Obligations. Client agrees to provide necessary access, cooperation, and timely input. Delays caused by the Client may affect timelines.",
  "Term; Termination. The engagement commences on full execution of this Agreement. Either party may terminate for material breach or at will with ten (10) business days' written notice. Provider is entitled to payment for all services rendered up to termination.",
  "Confidentiality. Both parties maintain confidentiality of proprietary or sensitive information exchanged; obligations survive termination.",
  'Disclaimer of Warranty. Provider makes no guarantee of funding success. All services are provided "as-is."',
  "Ownership. Each party retains its pre-existing materials and IP. Jointly developed work product is jointly owned; neither party may sell or license it to third parties without the other's written consent.",
  "Indemnification. Each party indemnifies the other against claims arising from its own gross negligence, misconduct, or breach.",
  "Limitation of Liability. Provider's liability is limited to the amount paid under this Agreement. Neither party is liable for indirect or consequential damages.",
  "Force Majeure. Neither party is liable for delays or failures caused by events beyond reasonable control.",
  "Governing Law. This Agreement is governed by the laws of the State of Arkansas. Venue lies in Benton County, AR.",
  "Entire Agreement. This document is the entire understanding between the parties. Modifications must be in writing and signed.",
  "Survival. Confidentiality, Ownership, Indemnification, Limitation of Liability, and Governing Law survive termination.",
];

export interface ContractParams {
  orgName: string;
  repName: string | null;
  email: string | null;
  templateKey: TemplateKey;
  amountCents: number | null;
  dateLabel: string; // caller passes a formatted date (no Date.now() in shared code paths)
}

// Builds the immutable contract body the signer agrees to. Plain text; the signer
// types their name + consents on /sign, and that becomes the electronic signature.
export function buildContractBody(p: ContractParams): string {
  const t = CONTRACT_TEMPLATES[p.templateKey];
  const fee = formatAmount(p.amountCents ?? t.defaultAmountCents);
  const terms = COMMON_TERMS.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
  const scope = t.scope.map((s) => `  - ${s}`).join("\n");

  return [
    "GRANTED, LLC",
    "240 S Main St, # 276",
    "Bentonville, AR 72712",
    "support@grantedco.com",
    "",
    `${t.name} Agreement`,
    "",
    `Dated: ${p.dateLabel}`,
    "",
    'This Consulting Services Agreement ("Agreement") is entered into between GRANTED, LLC, an ' +
      'Arkansas Limited Liability Company ("Provider"), and the Client identified below ("Client"). ' +
      "It governs the terms of engagement for grant-related consulting services.",
    "",
    "CLIENT",
    `  Organization: ${p.orgName}`,
    `  Representative: ${p.repName || "—"}`,
    `  Email: ${p.email || "—"}`,
    "",
    "SCOPE OF SERVICES (Exhibit A)",
    `  Package: ${t.name}`,
    `  Fee: ${fee}`,
    `  Term: ${t.term}`,
    scope,
    "",
    "KEY TERMS AND CONDITIONS",
    terms,
    "",
    "ELECTRONIC SIGNATURE",
    "By typing your full name and checking the consent box below, you agree that this constitutes " +
      "your electronic signature and that you intend to be legally bound by this Agreement. " +
      "GRANTED, LLC is represented by Shannon Anastosopolos, Founder & CEO.",
  ].join("\n");
}
