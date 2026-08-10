// Everything the platform knows about one client, as a list of provenance-carrying items,
// with markdown as ONE renderer over that list. GrantBot brick 0.
//
// ── WHY AN ITEM ARRAY AND NOT A STRING ──
//
// The obvious build is a function that returns markdown. It would be shorter and it would
// make GrantBot v1 and v2 rewrites of each other.
//
// v1's chat panel needs the same facts in a system prompt, not a document. v2 adds new
// SOURCES of the same facts (captured messages, Gemini call notes) rather than new
// formatting. So the durable thing is `ContextItem` -- one fact, with where it came from and
// when it was captured -- and every consumer is a renderer or a writer over that. Markdown is
// the first renderer; the prompt builder is the second; v2's capture is a writer. Nothing
// downstream has to re-derive what the platform knows.
//
// ── PURE ──
//
// No I/O, no server-only import. Rows in, items out. lib/grantbot/gather.ts does the reads.
// That split is what let this ship with its rules asserted offline rather than argued for --
// the same reason lib/documents/extract-shape.ts exists.

import type {
  Client,
  ClientDocument,
  ClientProfileChange,
  ConceptProposalRow,
  ReviewCard,
} from "@/types/database";
import { readDraftContent, draftCompleteness, completenessLabel } from "@/lib/intellengine/content";
import { formatProgramsForDump, formatPartnersForDump } from "@/lib/intake/narrative";
import { buildCommunityView } from "@/lib/clients/community";

// ── WHAT A FACT CARRIES ──

// WHERE a fact came from, which is a different question from which table holds it. A reader
// deciding how much to trust a line needs this more than the column name:
//   platform      -- the platform's own machinery recorded it (a document row, a card, a send)
//   client-stated -- the client's own words, from their intake or profile form
//   derived       -- computed or LLM-produced FROM something else (the distilled profile)
//   staff         -- written by a GRANTED staffer, in staff voice, internal
//   external      -- a third-party lookup (SAM, USASpending, Census, HRSA)
export type Provenance = "platform" | "client-stated" | "derived" | "staff" | "external";

export interface ContextItem {
  section: SectionKey;
  label: string;
  // Rendered value. May be multi-line markdown; never HTML.
  body: string;
  // The column or table it came from, precisely enough to go look.
  source: string;
  provenance: Provenance;
  // ISO timestamp, or NULL when the source records none.
  //
  // Null is a real answer and the renderer says so out loud. The alternative -- falling back
  // to the row's `updated_at` -- would put a precise-looking date on a value that may be years
  // older than the last thing that touched that row, which is the "asserts more currency than
  // it has" failure this whole pack is built against.
  capturedAt: string | null;
}

export type SectionKey =
  | "organization"
  | "eligibility"
  | "client-stated"
  | "distilled"
  | "internal"
  | "community"
  | "documents"
  | "assimilated"
  | "matches"
  | "concepts"
  | "drafts"
  | "alerts"
  | "activity";

// Order is the reader's order, not the schema's: identity, then facts, then what the org says,
// then what we derived from it, then the work. Analysis after the material it came from.
const SECTIONS: { key: SectionKey; title: string; preamble?: string }[] = [
  {
    key: "organization",
    title: "Organization",
    preamble:
      "These columns carry NO per-field timestamps. The row-touch date in the header is the newest age any of them could have, not their actual age.",
  },
  { key: "eligibility", title: "Registration and fiscal eligibility facts" },
  {
    key: "client-stated",
    title: "What the organization says about itself",
    preamble: "The client's own words, from their intake and profile form. Not verified by us.",
  },
  {
    key: "distilled",
    title: "Distilled profile (machine-derived)",
    preamble:
      "Produced by the profile refiner FROM the section above, for matching. Its own `inferred` and `gaps` lists are reproduced because they say where it stretched.",
  },
  {
    key: "internal",
    title: "INTERNAL — staff notes and rules",
    preamble:
      "Staff-authored, staff voice, never client-facing. If this pack is ever forwarded, this is the section that should not go.",
  },
  { key: "community", title: "Community context" },
  { key: "documents", title: "Documents on file" },
  { key: "assimilated", title: "Profile changes committed from documents" },
  { key: "matches", title: "Grant matches" },
  { key: "concepts", title: "Concept proposals" },
  { key: "drafts", title: "Pursuit drafts" },
  { key: "alerts", title: "Alerts sent" },
  { key: "activity", title: "Activity trail" },
];

// ── CAPS ──
//
// Full detail for the cards that are actually live work; one line for the rest. A pack that
// silently stopped at N would read as "that is everything", so whatever a cap drops is
// reported in the header (see `PackStats.dropped`).
export const MAX_DETAILED_CARDS = 15;
export const MAX_SUMMARY_CARDS = 60;
export const MAX_DOCUMENTS = 40;
export const MAX_CHANGES = 40;
export const MAX_ALERTS = 25;
export const MAX_EVENTS = 25;

export interface PackStats {
  documents: number;
  matches: number;
  detailedMatches: number;
  concepts: number;
  drafts: number;
  alerts: number;
  events: number;
  changes: number;
  // What a cap removed, in words a reader can act on. Empty when nothing was dropped.
  dropped: string[];
}

export interface ContextPack {
  orgName: string;
  generatedAt: string;
  generatedBy: string;
  // The clients row's own updated_at -- an upper bound on the age of every untimestamped
  // column, offered as exactly that and nothing more.
  clientRowTouchedAt: string;
  actorRole: string;
  items: ContextItem[];
  // Closed predicate list. See buildGaps.
  gaps: string[];
  omitted: string[];
  stats: PackStats;
}

// ── INPUT ──
//
// Narrow Picks rather than the full rows, so the select lists in gather.ts and the types here
// cannot drift apart -- and so `grants.raw_text` (megabytes of NOFO text, per row) can never
// be pulled to render forty words.
export type PackClient = Pick<
  Client,
  | "id" | "name" | "status" | "org_type" | "pipeline_stage" | "account_managed"
  | "primary_contact_name" | "primary_contact_email" | "primary_contact_phone" | "website"
  | "location_street" | "location_city" | "location_county" | "location_state" | "location_zip"
  | "service_area" | "rucc_codes" | "ein" | "uei" | "annual_budget"
  | "sam_registration_status" | "sam_expiration_date" | "sam_checked_at" | "sam_matched_name"
  | "nonprofit_finance" | "nonprofit_finance_checked_at"
  | "federal_grant_history" | "federal_history_verified" | "usaspending_checked_at"
  | "primary_funding_needs" | "project_stage" | "match_cost_share_capacity"
  | "known_constraints" | "hard_constraints" | "matching_rules" | "notes" | "next_step"
  | "intake_data" | "client_profile" | "profile_confirmed_at" | "created_at" | "updated_at"
>;

export type PackDocument = Pick<
  ClientDocument,
  | "id" | "title" | "kind" | "content_type" | "created_at" | "client_visible"
  | "intellengine_draft_id" | "extraction_status" | "extracted" | "extracted_at"
  | "extraction_error" | "review_note"
>;

export type PackChange = Pick<
  ClientProfileChange,
  "field" | "old_value" | "new_value" | "committed_at" | "committed_by_email" | "note" | "commit_id"
>;

export interface PackCardGrant {
  title: string | null;
  funder: string | null;
  fon: string | null;
  submission_deadline: string | null;
  award_range_min: number | null;
  award_range_max: number | null;
  award_range_is_estimate: boolean | null;
  description_brief: string | null;
}

export type PackCard = Pick<
  ReviewCard,
  | "id" | "grant_id" | "fit_score" | "proposed_role" | "recommended_prime" | "why_this_org"
  | "concept_synopsis" | "before_you_approve" | "decision" | "decided_at" | "decision_reason"
  | "hold_reason" | "interested_at" | "sent_at" | "pursuit_path"
> & { created_at: string; grants: PackCardGrant | null };

export type PackConcept = Pick<
  ConceptProposalRow,
  "card_id" | "status" | "proposal_data" | "generated_at" | "edited_at"
>;

export interface PackDraft {
  id: string;
  title: string | null;
  status: string;
  content: unknown;
  card_id: string | null;
}

export interface PackAlert {
  subject: string | null;
  status: string;
  created_at: string;
  grant_id: string | null;
}

export interface PackEvent {
  event_type: string;
  occurred_at: string;
  grant_id: string | null;
}

export interface PackInput {
  generatedAt: string;
  generatedBy: string;
  actorRole: string;
  client: PackClient;
  documents: PackDocument[];
  changes: PackChange[];
  cards: PackCard[];
  concepts: PackConcept[];
  drafts: PackDraft[];
  alerts: PackAlert[];
  events: PackEvent[];
}

// ── SMALL HELPERS ──

const clean = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const listOf = (v: unknown): string | null =>
  Array.isArray(v) && v.length
    ? v.filter((x) => typeof x === "string" && x.trim()).join(", ") || null
    : null;

// Date only, never a relative age. A pack is a document that gets pasted DAYS later, so
// "7 days ago" is a sentence that goes false while looking precise -- the exact staleness this
// pack is built to prevent. Absolute dates stay true forever; the header carries the one
// generation timestamp that makes them comparable.
export function isoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const bullets = (lines: (string | null)[]): string | null => {
  const kept = lines.filter((l): l is string => !!l && l.trim() !== "");
  return kept.length ? kept.map((l) => `- ${l}`).join("\n") : null;
};

// ── SECTION BUILDERS ──
//
// Each returns items or nothing. A field with no value contributes NO item, so a thin client
// produces a short pack rather than a long one full of "None" -- and what is genuinely absent
// is stated once, deliberately, in the gaps list.

function push(
  items: ContextItem[],
  section: SectionKey,
  label: string,
  body: string | null,
  source: string,
  provenance: Provenance,
  capturedAt: string | null,
): void {
  if (!body || body.trim() === "") return;
  items.push({ section, label, body: body.trim(), source, provenance, capturedAt });
}

function organization(input: PackInput, items: ContextItem[]): void {
  const c = input.client;
  push(items, "organization", "Name", c.name, "clients.name", "platform", null);
  push(items, "organization", "Status", c.status, "clients.status", "platform", null);
  push(items, "organization", "Organization type", c.org_type, "clients.org_type", "platform", null);
  push(items, "organization", "Pipeline stage", c.pipeline_stage, "clients.pipeline_stage", "platform", null);
  push(
    items,
    "organization",
    "Engagement",
    c.account_managed ? "Account-managed (premium)" : "Standard",
    "clients.account_managed",
    "platform",
    null,
  );
  push(
    items,
    "organization",
    "Primary contact",
    bullets([
      c.primary_contact_name,
      c.primary_contact_email,
      c.primary_contact_phone,
    ]),
    "clients.primary_contact_*",
    "platform",
    null,
  );
  push(items, "organization", "Website", c.website, "clients.website", "platform", null);
  push(
    items,
    "organization",
    "Address",
    [c.location_street, c.location_city, c.location_county ? `${c.location_county} County` : null, c.location_state, c.location_zip]
      .filter(Boolean)
      .join(", ") || null,
    "clients.location_*",
    "platform",
    null,
  );
  push(items, "organization", "Service area", listOf(c.service_area), "clients.service_area", "platform", null);
  push(items, "organization", "Project stage", c.project_stage, "clients.project_stage", "platform", null);
  push(
    items,
    "organization",
    "Priority areas (matcher)",
    listOf(c.primary_funding_needs),
    "clients.primary_funding_needs",
    "platform",
    null,
  );
  push(
    items,
    "organization",
    "Profile confirmed by the client",
    isoDate(c.profile_confirmed_at) ?? null,
    "clients.profile_confirmed_at",
    "client-stated",
    c.profile_confirmed_at ?? null,
  );
}

function eligibility(input: PackInput, items: ContextItem[]): void {
  const c = input.client;
  push(items, "eligibility", "EIN", c.ein, "clients.ein", "platform", null);
  push(items, "eligibility", "UEI", c.uei, "clients.uei", "platform", null);
  push(
    items,
    "eligibility",
    "SAM registration",
    bullets([
      c.sam_registration_status ? `Status: ${c.sam_registration_status}` : null,
      c.sam_expiration_date ? `Expires: ${isoDate(c.sam_expiration_date)}` : null,
      c.sam_matched_name ? `Matched entity name: ${c.sam_matched_name}` : null,
    ]),
    "clients.sam_*",
    "external",
    c.sam_checked_at ?? null,
  );
  const fin = c.nonprofit_finance as Record<string, unknown> | null;
  push(
    items,
    "eligibility",
    "Nonprofit finance (IRS filings)",
    fin
      ? bullets(
          Object.entries(fin)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`),
        )
      : null,
    "clients.nonprofit_finance",
    "external",
    c.nonprofit_finance_checked_at ?? null,
  );
  push(
    items,
    "eligibility",
    "Annual budget (self-reported)",
    c.annual_budget,
    "clients.annual_budget",
    "client-stated",
    null,
  );
  push(
    items,
    "eligibility",
    "Match / cost-share capacity",
    c.match_cost_share_capacity,
    "clients.match_cost_share_capacity",
    "client-stated",
    null,
  );
  push(
    items,
    "eligibility",
    "Federal grant history (self-reported)",
    c.federal_grant_history
      ? `${c.federal_grant_history}${c.federal_history_verified ? " (staff-verified)" : ""}`
      : null,
    "clients.federal_grant_history",
    "client-stated",
    null,
  );
  push(
    items,
    "eligibility",
    "USASpending cross-check last run",
    isoDate(c.usaspending_checked_at),
    "clients.usaspending_checked_at",
    "external",
    c.usaspending_checked_at ?? null,
  );
}

function clientStated(input: PackInput, items: ContextItem[]): void {
  const intake = (input.client.intake_data ?? {}) as Record<string, unknown>;
  // intake_data sometimes carries its own submitted_at from the public form; when it does that
  // IS the capture date for everything in this section, and when it does not there is none.
  const submitted = clean(intake.submitted_at);
  push(items, "client-stated", "Mission", clean(intake.mission), "clients.intake_data.mission", "client-stated", submitted);
  push(
    items,
    "client-stated",
    "What they need funded",
    clean(intake.funding_need),
    "clients.intake_data.funding_need",
    "client-stated",
    submitted,
  );
  push(
    items,
    "client-stated",
    "Priority areas",
    listOf(intake.priority_areas),
    "clients.intake_data.priority_areas",
    "client-stated",
    submitted,
  );
  push(
    items,
    "client-stated",
    "Programs",
    formatProgramsForDump(intake.programs),
    "clients.intake_data.programs",
    "client-stated",
    submitted,
  );
  push(
    items,
    "client-stated",
    "Partners",
    formatPartnersForDump(intake.partners, intake.partnerships),
    "clients.intake_data.partners",
    "client-stated",
    submitted,
  );
  push(
    items,
    "client-stated",
    "Anything else",
    clean(intake.additional_info),
    "clients.intake_data.additional_info",
    "client-stated",
    submitted,
  );
}

function distilled(input: PackInput, items: ContextItem[]): void {
  const p = input.client.client_profile;
  if (!p) return;
  // NO capturedAt EXISTS FOR ANY OF THIS. clients.client_profile has no generated_at column
  // anywhere in the schema (checked 2026-08-10), so every item here is honestly undated. Worth
  // a one-line migration before GrantBot v1 leans on it; until then the label says so.
  const at = null;
  push(items, "distilled", "Summary", clean(p.summary), "clients.client_profile.summary", "derived", at);
  push(items, "distilled", "Mission (distilled)", clean(p.mission), "clients.client_profile.mission", "derived", at);
  push(
    items,
    "distilled",
    "Core capabilities",
    listOf(p.core_capabilities),
    "clients.client_profile.core_capabilities",
    "derived",
    at,
  );
  push(
    items,
    "distilled",
    "Program areas",
    Array.isArray(p.program_areas)
      ? bullets(
          p.program_areas.map((a) => {
            const area = a as unknown as Record<string, unknown>;
            const name = clean(area.name) ?? clean(area.area);
            const detail = clean(area.description) ?? clean(area.detail);
            return name ? `${name}${detail ? ` — ${detail}` : ""}` : detail;
          }),
        )
      : null,
    "clients.client_profile.program_areas",
    "derived",
    at,
  );
  push(
    items,
    "distilled",
    "Populations served",
    listOf(p.populations_served),
    "clients.client_profile.populations_served",
    "derived",
    at,
  );
  const geo = p.geographic_scope as unknown as Record<string, unknown> | null;
  push(
    items,
    "distilled",
    "Geographic scope",
    geo
      ? bullets([
          clean(geo.footprint),
          clean(geo.scale) ? `Scale: ${clean(geo.scale)}` : null,
          listOf(geo.states) ? `States: ${listOf(geo.states)}` : null,
        ])
      : null,
    "clients.client_profile.geographic_scope",
    "derived",
    at,
  );
  const prime = p.prime_capacity as unknown as Record<string, unknown> | null;
  push(
    items,
    "distilled",
    "Prime capacity",
    prime
      ? bullets([
          `Can prime: ${prime.can_prime ? "yes" : "no"}`,
          clean(prime.rationale),
          clean(prime.conditional_on) ? `Conditional on: ${clean(prime.conditional_on)}` : null,
        ])
      : null,
    "clients.client_profile.prime_capacity",
    "derived",
    at,
  );
  push(
    items,
    "distilled",
    "Supporting roles it can genuinely fill",
    listOf(p.supporting_roles),
    "clients.client_profile.supporting_roles",
    "derived",
    at,
  );
  push(items, "distilled", "Funding priorities", listOf(p.funding_priorities), "clients.client_profile.funding_priorities", "derived", at);
  push(items, "distilled", "Partnerships (distilled)", listOf(p.partnerships), "clients.client_profile.partnerships", "derived", at);
  push(
    items,
    "distilled",
    "Fiscal notes",
    p.fiscal_notes
      ? bullets([
          clean(p.fiscal_notes.annual_budget) ? `Annual budget: ${clean(p.fiscal_notes.annual_budget)}` : null,
          clean(p.fiscal_notes.match_capacity) ? `Match capacity: ${clean(p.fiscal_notes.match_capacity)}` : null,
          clean(p.fiscal_notes.rurality) ? `Rurality: ${clean(p.fiscal_notes.rurality)}` : null,
        ])
      : null,
    "clients.client_profile.fiscal_notes",
    "derived",
    at,
  );
  // The self-report is AUTHORITATIVE and the USASpending line is a fuzzy name match; the
  // refiner's own rule, reproduced so a reader does not invert them.
  push(
    items,
    "distilled",
    "Federal history",
    bullets([
      clean(p.federal_history?.self_reported) ? `Self-reported (AUTHORITATIVE): ${clean(p.federal_history.self_reported)}` : null,
      clean(p.federal_history?.usaspending_crosscheck)
        ? `USASpending cross-check (fuzzy name match, never overrides the self-report): ${clean(p.federal_history.usaspending_crosscheck)}`
        : null,
      clean(p.federal_history?.discrepancy) ? `DISCREPANCY noted: ${clean(p.federal_history.discrepancy)}` : null,
    ]),
    "clients.client_profile.federal_history",
    "derived",
    at,
  );
  // The refiner's own honesty fields, reproduced rather than summarised: they say where it
  // guessed, which is the first thing a reader of a derived profile needs.
  push(items, "distilled", "Flagged as INFERRED by the refiner", listOf(p.inferred), "clients.client_profile.inferred", "derived", at);
  push(items, "distilled", "Flagged as GAPS by the refiner", listOf(p.gaps), "clients.client_profile.gaps", "derived", at);
}

function internal(input: PackInput, items: ContextItem[]): void {
  const c = input.client;
  push(items, "internal", "Staff notes", c.notes, "clients.notes", "staff", null);
  push(items, "internal", "Next step", c.next_step, "clients.next_step", "staff", null);
  push(items, "internal", "Known constraints", c.known_constraints, "clients.known_constraints", "staff", null);
  push(items, "internal", "Matching rules", c.matching_rules, "clients.matching_rules", "staff", null);
  push(
    items,
    "internal",
    "Hard constraints (enforced by the matcher)",
    Array.isArray(c.hard_constraints) && c.hard_constraints.length
      ? bullets(
          c.hard_constraints.map((h) => {
            const rec = h as unknown as Record<string, unknown>;
            return [clean(rec.kind), clean(rec.value), clean(rec.note)].filter(Boolean).join(" · ") || null;
          }),
        )
      : null,
    "clients.hard_constraints",
    "staff",
    null,
  );
}

function community(input: PackInput, items: ContextItem[]): void {
  // Reuses the dashboard's view-model rather than re-reading the jsonb: it already keeps
  // "never checked" / "checked, no data" / "checked, negative" apart, which is the same
  // distinction this pack exists to preserve. A second derivation would drift from it.
  //
  // And unlike the distilled profile, this source DOES record when it ran (`checkedAt`), so
  // these items are honestly dated rather than labelled unknown.
  const view = buildCommunityView(input.client);
  if (view.unpulled) return; // one line in the gaps list, not three "never looked up" rows
  const src = "clients.client_profile.community_context";
  const at = view.checkedAt;
  push(
    items,
    "community",
    "Geography these indicators describe",
    view.placeLabel,
    "clients.location_*",
    "platform",
    null,
  );
  push(
    items,
    "community",
    "Median household income",
    view.income.state === "value" && view.income.amount !== null
      ? `$${view.income.amount.toLocaleString()} (${view.income.geographyName ?? "geography not recorded"})`
      : view.income.state === "none"
        ? "Looked up; the source suppressed or did not resolve a value."
        : "Never looked up.",
    src,
    "external",
    at,
  );
  push(
    items,
    "community",
    "Federal shortage designations",
    view.shortage.state === "value"
      ? view.shortage.lines.join("\n")
      : view.shortage.state === "none"
        ? "The address was tested against HRSA's polygons and falls in NONE. That is a real negative finding, not a missing value."
        : "Never looked up.",
    src,
    "external",
    at,
  );
  push(
    items,
    "community",
    "Rurality (RUCC)",
    view.rurality.state === "value"
      ? [view.rurality.label, view.rurality.detail].filter(Boolean).join(" — ")
      : input.client.rucc_codes,
    "clients.rucc_codes",
    "external",
    null,
  );
  push(items, "community", "Source vintage", view.vintage, src, "external", at);
}

function documents(input: PackInput, items: ContextItem[], stats: PackStats): void {
  const shown = input.documents.slice(0, MAX_DOCUMENTS);
  if (input.documents.length > shown.length) {
    stats.dropped.push(
      `${input.documents.length - shown.length} document(s) beyond the newest ${MAX_DOCUMENTS} are not listed.`,
    );
  }
  for (const d of shown) {
    const ex = (d.extracted ?? {}) as Record<string, unknown>;
    const body = bullets([
      `Filed as: ${d.kind}${d.intellengine_draft_id ? " (pursuit attachment)" : " (organization document)"}`,
      clean(ex.docType) ? `Reads as: ${clean(ex.docType)}` : null,
      clean(ex.docDate) ? `Document date, AS THE DOCUMENT STATES IT (a claim, not verified): ${clean(ex.docDate)}` : null,
      clean(ex.synopsis),
      d.extraction_status === "failed"
        ? `Extraction FAILED: ${clean(d.extraction_error) ?? "no reason recorded"}`
        : d.extraction_status === "pending"
          ? "Not extracted yet."
          : null,
      clean(d.review_note) ? `Reviewer note: ${clean(d.review_note)}` : null,
      d.client_visible ? "Visible to the client." : "Staff-only (not visible to the client).",
      // The pack cannot carry document CONTENTS: extraction parses the file in memory and
      // stores only this synopsis. Said per document, because the absence is easy to forget
      // when a synopsis reads well.
      "Full text is NOT stored by the platform — only the synopsis above.",
    ]);
    push(
      items,
      "documents",
      d.title,
      body,
      "client_documents + client_documents.extracted",
      "platform",
      d.extracted_at ?? d.created_at,
    );
  }
  stats.documents = input.documents.length;
}

function assimilated(input: PackInput, items: ContextItem[], stats: PackStats): void {
  const shown = input.changes.slice(0, MAX_CHANGES);
  if (input.changes.length > shown.length) {
    stats.dropped.push(
      `${input.changes.length - shown.length} committed profile change(s) beyond the newest ${MAX_CHANGES} are not listed.`,
    );
  }
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return "(empty)";
    if (typeof v === "string") return v.trim() === "" ? "(empty)" : v.trim();
    return JSON.stringify(v);
  };
  for (const ch of shown) {
    push(
      items,
      "assimilated",
      ch.field,
      bullets([
        `${render(ch.old_value)} → ${render(ch.new_value)}`,
        `Committed by ${ch.committed_by_email ?? "unknown"}`,
        clean(ch.note) ? `Note: ${clean(ch.note)}` : null,
      ]),
      "client_profile_changes",
      "platform",
      ch.committed_at,
    );
  }
  stats.changes = input.changes.length;
}

// Live work first, then everything else in one line each. "Live" = a decision or a send has
// happened, which is what makes a card worth a paragraph.
// A held card is `decision: 'pending'` WITH a hold_reason -- there is no 'hold' member of
// CardDecision (it is pending | approved | passed), and a card parked with a reason is live
// work as much as an approved one is.
function isLiveCard(c: PackCard): boolean {
  return (
    c.decision === "approved" ||
    !!c.interested_at ||
    !!c.sent_at ||
    !!c.hold_reason ||
    !!c.pursuit_path
  );
}

function matches(input: PackInput, items: ContextItem[], stats: PackStats): void {
  const live = input.cards.filter(isLiveCard);
  const rest = input.cards.filter((c) => !isLiveCard(c));
  const detailed = live.slice(0, MAX_DETAILED_CARDS);
  const summary = [...live.slice(MAX_DETAILED_CARDS), ...rest].slice(0, MAX_SUMMARY_CARDS);
  const total = input.cards.length;
  const listed = detailed.length + summary.length;
  if (total > listed) {
    stats.dropped.push(`${total - listed} match(es) are not listed at all (cap: ${MAX_SUMMARY_CARDS}).`);
  }
  if (live.length > detailed.length) {
    stats.dropped.push(
      `${live.length - detailed.length} live match(es) appear as one-liners rather than in full (cap: ${MAX_DETAILED_CARDS}).`,
    );
  }

  const head = (c: PackCard): string => {
    const g = c.grants;
    const bits = [
      g?.title ?? "(grant row missing)",
      g?.funder ?? null,
      g?.fon ?? null,
      g?.submission_deadline ? `due ${isoDate(g.submission_deadline)}` : null,
    ].filter(Boolean);
    return bits.join(" · ");
  };

  for (const c of detailed) {
    const g = c.grants;
    const award =
      g && (g.award_range_min !== null || g.award_range_max !== null)
        ? `Award range: ${g.award_range_min?.toLocaleString() ?? "?"}–${g.award_range_max?.toLocaleString() ?? "?"}${g.award_range_is_estimate === false ? "" : " (ESTIMATE)"}`
        : null;
    push(
      items,
      "matches",
      head(c),
      bullets([
        `Fit ${c.fit_score}/3`,
        c.proposed_role ? `Proposed role: ${c.proposed_role}` : null,
        c.recommended_prime ? `Recommended prime: ${c.recommended_prime}` : null,
        award,
        c.pursuit_path ? `Pursuit path: ${c.pursuit_path}` : null,
        `Decision: ${c.decision}${c.decided_at ? ` on ${isoDate(c.decided_at)}` : ""}`,
        clean(c.decision_reason) ? `Decision reason: ${clean(c.decision_reason)}` : null,
        clean(c.hold_reason) ? `Hold reason: ${clean(c.hold_reason)}` : null,
        c.interested_at ? `Client expressed interest on ${isoDate(c.interested_at)}` : null,
        c.sent_at ? `Alert sent ${isoDate(c.sent_at)}` : "No alert sent for this card.",
        clean(c.concept_synopsis) ? `Concept synopsis: ${clean(c.concept_synopsis)}` : null,
        Array.isArray(c.why_this_org) && c.why_this_org.length
          ? `Why this org:\n${c.why_this_org.map((w) => `  - ${w}`).join("\n")}`
          : null,
        Array.isArray(c.before_you_approve) && c.before_you_approve.length
          ? `Before you approve (STAFF VOICE, internal):\n${c.before_you_approve.map((w) => `  - ${w}`).join("\n")}`
          : null,
        clean(g?.description_brief) ? `Grant in brief: ${clean(g?.description_brief)}` : null,
      ]),
      "review_cards + grants",
      "platform",
      c.created_at,
    );
  }

  for (const c of summary) {
    push(
      items,
      "matches",
      head(c),
      `Fit ${c.fit_score}/3 · decision: ${c.decision}${c.sent_at ? ` · alert sent ${isoDate(c.sent_at)}` : ""}`,
      "review_cards + grants",
      "platform",
      c.created_at,
    );
  }

  stats.matches = total;
  stats.detailedMatches = detailed.length;
}

function concepts(input: PackInput, items: ContextItem[], stats: PackStats): void {
  // SUMMARISED, not reproduced. Two full proposals would roughly double the pack, and the
  // scope paragraph plus the consortium shape is what a reader needs to know one exists and
  // what it claims. The full document lives in the console.
  for (const cp of input.concepts) {
    const card = input.cards.find((c) => c.id === cp.card_id);
    const title = card?.grants?.title ?? "(grant row missing)";
    if (cp.status !== "ready" || !cp.proposal_data) {
      push(
        items,
        "concepts",
        title,
        `Status: ${cp.status} — no proposal content to show.`,
        "concept_proposals",
        "derived",
        cp.generated_at ?? null,
      );
      continue;
    }
    const p = cp.proposal_data;
    push(
      items,
      "concepts",
      title,
      bullets([
        `Role: ${p.role}`,
        `Total project amount: ${p.total_project_amount} (ESTIMATE)`,
        p.estimated_match ? `Estimated match: ${p.estimated_match} (ESTIMATE)` : "No match required per the NOFO.",
        p.project_term ? `Project term: ${p.project_term}` : null,
        p.scope,
        p.partners.length
          ? `Consortium (${p.partners.length}):\n${p.partners
              .map(
                (pt) =>
                  `  - ${pt.name ?? pt.org_type_label ?? "(unnamed)"} — ${pt.role} [${pt.source}${pt.source === "suggested" ? ", UNVERIFIED" : ""}]`,
              )
              .join("\n")}`
          : null,
        cp.edited_at ? `Edited by staff on ${isoDate(cp.edited_at)}` : null,
      ]),
      "concept_proposals.proposal_data",
      "derived",
      cp.edited_at ?? cp.generated_at ?? null,
    );
  }
  stats.concepts = input.concepts.length;
}

function drafts(input: PackInput, items: ContextItem[], stats: PackStats): void {
  for (const d of input.drafts) {
    const content = readDraftContent(d.content);
    const done = completenessLabel(draftCompleteness(content));
    const written = content.sections.filter((s) => s.draft.trim() !== "");
    push(
      items,
      "drafts",
      d.title ?? "(untitled draft)",
      bullets([
        `Flow status: ${d.status} · ${done}`,
        clean(content.scope.scope) ? `Scope as the client wrote it:\n${content.scope.scope}` : null,
        content.scope.budget ? `Budget: ${content.scope.budget}` : null,
        content.scope.role ? `Role: ${content.scope.role}` : null,
        clean(content.scope.notes) ? `Notes: ${clean(content.scope.notes)}` : null,
        content.scope.partners.length
          ? `Partners named in the scope:\n${content.scope.partners.map((p) => `  - ${p.name} — ${p.role}`).join("\n")}`
          : null,
        written.length
          ? `Proposal sections written (${written.length}):\n${written
              .map((s) => `  - ${s.id} [${s.source}]: ${s.draft.slice(0, 400)}${s.draft.length > 400 ? "…" : ""}`)
              .join("\n")}`
          : "No proposal sections written yet.",
      ]),
      "intellengine_drafts.content",
      "client-stated",
      content.scope.savedAt ?? null,
    );
  }
  stats.drafts = input.drafts.length;
}

function alerts(input: PackInput, items: ContextItem[], stats: PackStats): void {
  const shown = input.alerts.slice(0, MAX_ALERTS);
  if (input.alerts.length > shown.length) {
    stats.dropped.push(`${input.alerts.length - shown.length} alert(s) beyond the newest ${MAX_ALERTS} are not listed.`);
  }
  for (const a of shown) {
    push(
      items,
      "alerts",
      a.subject ?? "(no subject recorded)",
      `Status: ${a.status}`,
      "grant_alerts",
      "platform",
      a.created_at,
    );
  }
  stats.alerts = input.alerts.length;
}

function activity(input: PackInput, items: ContextItem[], stats: PackStats): void {
  const shown = input.events.slice(0, MAX_EVENTS);
  if (input.events.length > shown.length) {
    stats.dropped.push(`${input.events.length - shown.length} activity event(s) beyond the newest ${MAX_EVENTS} are not listed.`);
  }
  for (const e of shown) {
    push(items, "activity", e.event_type, `Recorded ${isoDate(e.occurred_at)}`, "pipeline_events", "platform", e.occurred_at);
  }
  stats.events = input.events.length;
}

// ── THE GAPS ──
//
// A CLOSED LIST OF PREDICATES, and that is the whole design. The temptation is a section that
// "notes anything concerning", which is an invitation to invent concerns -- the compliance-step
// fabrication in prose form. Every line below is a fact about a specific absence, each one
// checkable against a column, and nothing gets added here without a predicate.
export function buildGaps(input: PackInput): string[] {
  const c = input.client;
  const gaps: string[] = [];
  const intake = (c.intake_data ?? {}) as Record<string, unknown>;

  if (input.documents.length === 0) {
    gaps.push("No documents on file. Nothing in this pack has been read out of a source document.");
  }
  if (!c.profile_confirmed_at) {
    gaps.push(
      "The client has NEVER confirmed their own profile. Contact and location details are as staff entered them.",
    );
  }
  if (!c.client_profile) {
    gaps.push("No distilled profile exists, so there is no matcher-facing read of this organization.");
  } else {
    gaps.push(
      "The distilled profile carries NO generation date (no such column exists), so its age relative to everything else here is unknown.",
    );
  }
  if (!c.sam_checked_at) {
    gaps.push("SAM registration has never been checked for this organization.");
  } else if (c.sam_expiration_date && c.sam_expiration_date < input.generatedAt.slice(0, 10)) {
    gaps.push(`SAM registration EXPIRED on ${isoDate(c.sam_expiration_date)} (checked ${isoDate(c.sam_checked_at)}).`);
  }
  if (!clean(intake.mission)) {
    gaps.push("The intake carries no mission statement in the organization's own words.");
  }
  if (input.cards.length === 0) {
    gaps.push("No grant matches have been carded for this client.");
  }
  if (input.changes.length === 0) {
    gaps.push("No profile change has ever been committed from a document.");
  }
  if (buildCommunityView(c).unpulled) {
    gaps.push("Community context (Census income, HRSA shortage designations) has never been looked up.");
  }
  if (!c.ein) gaps.push("No EIN on file.");
  if (!c.uei) gaps.push("No UEI on file.");
  return gaps;
}

// What this pack structurally cannot contain. Stated in the pack itself so a reader is never
// left to assume that silence means absence in the world rather than absence in the platform.
export const OMISSIONS: string[] = [
  "Commercial and billing data (engagement tier, retainer hours, hours logged, amounts owed, invoices, contract dates) — deliberately excluded.",
  "Raw document text — the platform never stores it; extraction keeps only the synopses above.",
  "Email threads, call notes, and anything from a Claude project — none of it lives in this platform.",
  "Client member logins and account data.",
];

// ── ASSEMBLY ──

export function buildContextPack(input: PackInput): ContextPack {
  const items: ContextItem[] = [];
  const stats: PackStats = {
    documents: 0,
    matches: 0,
    detailedMatches: 0,
    concepts: 0,
    drafts: 0,
    alerts: 0,
    events: 0,
    changes: 0,
    dropped: [],
  };

  organization(input, items);
  eligibility(input, items);
  clientStated(input, items);
  distilled(input, items);
  internal(input, items);
  community(input, items);
  documents(input, items, stats);
  assimilated(input, items, stats);
  matches(input, items, stats);
  concepts(input, items, stats);
  drafts(input, items, stats);
  alerts(input, items, stats);
  activity(input, items, stats);

  return {
    orgName: input.client.name,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    clientRowTouchedAt: input.client.updated_at,
    actorRole: input.actorRole,
    items,
    gaps: buildGaps(input),
    omitted: OMISSIONS,
    stats,
  };
}

// ── MARKDOWN: ONE RENDERER OVER THE ITEMS ──

function itemFooter(item: ContextItem): string {
  const captured = item.capturedAt
    ? `captured ${isoDate(item.capturedAt)}`
    : "NO TIMESTAMP RECORDED";
  return `_${item.source} · ${item.provenance} · ${captured}_`;
}

export function renderMarkdown(pack: ContextPack): string {
  const out: string[] = [];
  out.push(`# Context pack — ${pack.orgName}`);
  out.push("");
  out.push(
    `Generated ${pack.generatedAt} from the GRANTED platform by ${pack.generatedBy} (${pack.actorRole}).`,
  );
  out.push(
    "Every item below carries its source, its provenance, and when it was captured. " +
      "Dates are absolute, never relative, because this document will be read later than it was written. " +
      "An item marked NO TIMESTAMP RECORDED has an age the platform genuinely does not know — do not assume it is current.",
  );
  out.push("");
  out.push(
    `**In this pack:** ${pack.stats.documents} document(s) · ${pack.stats.matches} match(es) ` +
      `(${pack.stats.detailedMatches} in full) · ${pack.stats.concepts} concept proposal(s) · ` +
      `${pack.stats.drafts} pursuit draft(s) · ${pack.stats.changes} committed profile change(s) · ` +
      `${pack.stats.alerts} alert(s) · ${pack.stats.events} activity event(s).`,
  );
  out.push("");
  out.push(`**The \`clients\` row was last touched ${isoDate(pack.clientRowTouchedAt)}.**`);
  out.push("");
  out.push("**Not in this pack:**");
  for (const o of pack.omitted) out.push(`- ${o}`);
  if (pack.stats.dropped.length) {
    out.push("");
    out.push("**Trimmed by a cap (so this is NOT everything):**");
    for (const d of pack.stats.dropped) out.push(`- ${d}`);
  }

  let n = 0;
  for (const section of SECTIONS) {
    const mine = pack.items.filter((i) => i.section === section.key);
    // A section with nothing in it prints NOTHING. An empty heading reads as a fact about the
    // organization ("no community context") when it is a fact about our data, and the gaps
    // list is where that belongs.
    if (mine.length === 0) continue;
    n += 1;
    out.push("");
    out.push("---");
    out.push("");
    out.push(`## ${n}. ${section.title}`);
    if (section.preamble) {
      out.push("");
      out.push(`_${section.preamble}_`);
    }
    for (const item of mine) {
      // TWO SHAPES, chosen by the value rather than by the section. A one-line value under its
      // own `###` heading with a footer beneath costs five lines to say "Status: lead", which
      // pads a thin client's pack into something that looks more substantial than it is. Short
      // values render as one bullet with the footer inline; anything multi-line or long keeps
      // the heading, because that is what makes a paragraph findable.
      const short = !item.body.includes("\n") && item.body.length <= 120;
      out.push("");
      if (short) {
        out.push(`- **${item.label}:** ${item.body}  ${itemFooter(item)}`);
      } else {
        out.push(`### ${item.label}`);
        out.push("");
        out.push(item.body);
        out.push("");
        out.push(itemFooter(item));
      }
    }
  }

  out.push("");
  out.push("---");
  out.push("");
  out.push(`## ${n + 1}. What the platform does NOT know about this client`);
  out.push("");
  out.push(
    "_A fixed list of checks, not an assessment. Each line is a specific absence in our data._",
  );
  out.push("");
  if (pack.gaps.length === 0) {
    out.push("- Every check in this list passed.");
  } else {
    for (const g of pack.gaps) out.push(`- ${g}`);
  }
  out.push("");
  return out.join("\n");
}
