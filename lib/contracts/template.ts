// GRANTED engagement-letter templates, ported from the GOH contract generator to
// a parameterized PLAIN-TEXT builder. Chunk 1 records the signature against this
// exact text (stored as contracts.body_snapshot, immutable). Chunk 2 renders the
// styled/signed PDF -- the wording lives here so both chunks share one source.
//
// Terms are faithful to the GOH engagement letter (AR governing law, Benton
// County venue, disclaimer of warranty, confidentiality, ownership, etc.).

export type TemplateKey = "launch" | "build" | "partner" | "custom";

export interface TemplateMeta {
  key: TemplateKey;
  name: string;
  defaultAmountCents: number | null; // null = admin must enter (custom)
  term: string;
  scope: string[]; // Exhibit A bullet lines
}

export const CONTRACT_TEMPLATES: Record<TemplateKey, TemplateMeta> = {
  launch: {
    key: "launch",
    name: "Launch",
    defaultAmountCents: 250_000, // $2,500 one-time
    term: "One-time engagement",
    scope: [
      "Discovery call: a working session to understand the organization's mission, priorities, and projects.",
      "Scored Grant Report: a prioritized, eligibility-scored list of high-impact grant opportunities built around the client's profile.",
      "Strategy session: a one (1) hour debrief to walk through the report and map next steps.",
      "One-time engagement: no ongoing grant monitoring and no proposal-development support.",
    ],
  },
  build: {
    key: "build",
    name: "Build",
    defaultAmountCents: 999_900, // $9,999 paid in full
    term: "12 months",
    scope: [
      "Everything in Launch (discovery call, scored Grant Report, strategy session).",
      "Daily grant monitoring for twelve (12) months across the client's priority areas.",
      "Live alerts on newly-surfaced and priority-mapped in-scope grants, sent to the client's contact.",
      "Does not include proposal-development support.",
    ],
  },
  partner: {
    key: "partner",
    name: "Partner",
    defaultAmountCents: 2_500_000, // $25,000 annual
    term: "12 months (annual)",
    scope: [
      "Everything in Build (Launch deliverables + 12 months daily monitoring + live alerts).",
      "Embedded fractional grants team acting as an extension of the client's staff.",
      "Approximately one hundred (100) hours of proposal-development support over the term.",
      "Consortium and partner strategy: identifying and structuring prime/partner roles on collaborative applications.",
      "Priority access to the GRANTED team for time-sensitive opportunities.",
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
