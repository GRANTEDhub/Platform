// WHAT an extraction may say, and what a model's raw output is cut down to before anything
// else sees it. Assimilation step (iv), the half with no I/O in it.
//
// ── WHY THIS IS A SEPARATE MODULE FROM extract.ts ──
//
// extract.ts is `server-only` and performs an extraction: storage read, PDF/DOCX parse, LLM
// call. NONE of that runs in the sandbox this was written in, and it never will -- so if the
// validator lived beside it, the property that actually protects the profile ("a wrong or
// hostile extraction is dropped, not written") would be unverifiable here and would ship on
// an argument instead of a test.
//
// So everything with a DECISION in it lives here: pure, no server-only import, no SDK, no
// network. What is left in extract.ts is composition -- download, parse, call, hand the raw
// tool input to validateExtraction. Every rule below is exercised offline against this module
// as compiled, not against a mirror of it.
//
// The prompt lives here too, beside the schema and the validator, because the three have to
// agree: a prompt that asks for a field the schema does not declare, or a schema the
// validator drops, is a silent no-op.

import { ORG_TYPES } from "@/lib/clients/org-types";
import { PRIORITY_AREAS, US_STATES } from "@/lib/intake/fields";
import { PROPOSABLE_FIELDS } from "@/lib/documents/proposal";
import { parseNarrative } from "@/lib/intake/narrative";

// ── THE SHAPE ──

// Every field OPTIONAL, and that is the contract: an extractor that cannot find something
// must OMIT it, never guess and never send an empty value. A missing field proposes nothing,
// which is the honest outcome. An empty one would propose CLEARING a profile field, which no
// document justifies.
export interface ExtractedDocument {
  // What kind of document this appears to be, in the extractor's own words ("IRS Form 990",
  // "audited financial statements"). Display only -- it never becomes a `kind`, because kind
  // is a client's declared choice from a fixed allowlist.
  docType?: string;
  // NO `title` FIELD, and its absence is the decision -- see the commit that removed it. The
  // review screen takes the title from the stored client_documents.title column, so a
  // computed title would have been stored and silently ignored. Add it back only with an
  // answer to "does an extraction get to RENAME a document?".
  synopsis?: string;
  // AS WRITTEN IN THE DOCUMENT, and a CLAIM until a human accepts it. Kept as free text
  // rather than a date: "FY2024" and "year ended June 30, 2025" are what documents actually
  // say, and coercing them to a timestamp invents precision.
  docDate?: string;
  // The profile-shaped facts. Keys must be in PROPOSABLE_FIELDS or they are dropped -- that
  // allowlist is what keeps assimilation unable to write anything a client could not type by
  // hand.
  fields?: Record<string, unknown>;
  // ── PER-FIELD PROVENANCE, and it has a real consumer ──
  //
  // A verbatim snippet from the document for each proposed field, keyed by field name and
  // rendered under that field's label on the review screen.
  //
  // This exists for ONE failure, the likeliest wrong extraction there is: a 990's contact
  // block belongs to the PAID PREPARER, and an audited financial statement's letterhead
  // belongs to the AUDITOR. Both are real contact details, correctly read off the page, and
  // both are the wrong organization -- so no amount of shape validation catches them and a
  // reviewer looking at "Contact email: jsmith@cpa-firm.com" has no way to tell without
  // opening the PDF. Quoted beside the value, "Paid Preparer Use Only ... jsmith@cpa-firm.com"
  // gives it away at a glance.
  //
  // It is also a brake on the extractor: a field it cannot quote is a field it invented, and
  // the prompt makes the quote a precondition for proposing at all.
  evidence?: Record<string, string>;
}

// ── FAILURE MESSAGES ──
//
// Read by a human on the review screen, so each one says what to DO about it. They are
// exported and distinct because the review screen renders `failed` differently from
// `ready`-with-nothing, and collapsing two causes into one message is how "we could not read
// this" becomes indistinguishable from "we read it and it had nothing in it".

export const SPREADSHEET_UNSUPPORTED =
  "We can't read spreadsheets yet. Upload a PDF or Word version and we'll pull the details from that.";

// A legacy binary .doc is NOT a docx: mammoth reads the Open XML format only, and pdf-parse
// obviously does not apply. The stub listed application/msword as extractable, which was
// harmless while nothing parsed anything and would now surface as a generic parse failure.
export const LEGACY_DOC_UNSUPPORTED =
  "This is an older Word format (.doc) we can't read. Save it as a PDF or .docx and upload that.";

export const UNREADABLE_TYPE =
  "We can't read this kind of file. Upload a PDF or Word document and we'll pull the details from that.";

// THE ONE SHANNON ASKED FOR BY NAME. A scanned document is a picture of text: pdf-parse
// returns nothing or a few stray characters, and if that went to the model it would honestly
// find nothing -- landing as `ready` with no proposals, which the screen states as "the
// extraction found no profile details this document could add". That sentence would be a lie.
// The document may be full of exactly what we wanted; we cannot see any of it.
export const NO_TEXT_FOUND =
  "We couldn't find any readable text in this file — it looks like a scan or a photo rather than a digital document. We can't pull anything from it as-is. A text-based PDF or Word version would work.";

export const DOWNLOAD_FAILED =
  "We couldn't retrieve the stored file. Try again, and re-upload it if this keeps happening.";

export const PARSE_FAILED =
  "We couldn't open this file — it may be password-protected or damaged. Try re-saving it and uploading again.";

// No key configured / the model call could not be made at all. Distinct from a failure the
// model returned, because the fix is ours and not the document's.
export const EXTRACTOR_UNAVAILABLE =
  "The extractor isn't available right now. Nothing was changed — try again shortly.";

export const EXTRACTOR_FAILED =
  "The extractor couldn't finish reading this document. Nothing was changed — try again, and re-extract if it keeps failing.";

// A truncated tool call is a PARTIAL object: some fields present, some cut off mid-value.
// Treated as a failure rather than salvaged, following lib/clients/profile.ts, because
// "half an extraction" is indistinguishable from a complete one once it is stored.
export const EXTRACTOR_TRUNCATED =
  "This document is too long for one pass — the extractor ran out of room. Nothing was recorded. Try a shorter document or the most relevant section.";

// ── WHICH FILES WE CAN GET TEXT OUT OF ──

export type ParseableKind = "pdf" | "docx";

// Routed on the stored path's EXTENSION FIRST, content type second.
//
// The precedent is lib/grants/nofo.ts, which routes on extension only because Simpler.gov
// mislabels .docx as application/msword -- and the same mislabel reaches us from a different
// direction: content_type here is read back from storage, which took it from the browser,
// which takes it from the OS. Windows reports .docx as application/msword often enough that
// extension-first is the more reliable of the two. Content type is still consulted, because
// clientUploadPath sanitises the filename and a name with no extension is possible.
export function parseableKind(
  contentType: string | null | undefined,
  storagePath: string | null | undefined,
): ParseableKind | null {
  const ext = (storagePath ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  // A legacy .doc must NOT fall through to the content-type branch below, where
  // application/msword would claim it as docx.
  if (ext === "doc") return null;
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "application/pdf") return "pdf";
  if (ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  return null;
}

// The right refusal for a file we cannot parse. Spreadsheets get their own sentence because
// they are the common case (a client's budget or program roster is a workbook), and legacy
// .doc gets one because "save it as a .docx" is an action the person can take.
export function unsupportedMessage(
  contentType: string | null | undefined,
  storagePath: string | null | undefined,
): string {
  const ext = (storagePath ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const ct = (contentType ?? "").toLowerCase();
  if (ext === "doc" || ct === "application/msword") return LEGACY_DOC_UNSUPPORTED;
  const spreadsheet =
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "csv" ||
    ct.includes("spreadsheet") ||
    ct.includes("excel") ||
    ct === "text/csv";
  return spreadsheet ? SPREADSHEET_UNSUPPORTED : UNREADABLE_TYPE;
}

// Below this many characters of extracted text we do not claim to have read the document.
//
// A judgment, and deliberately low: a one-page letterhead PDF carries several hundred
// characters, while a scan carries zero or a stray page number from a footer stamp. The cost
// of being wrong is asymmetric -- too low and a nearly-empty document reports "nothing to
// add" (recoverable, the reviewer opens it); too high and a genuinely short document is
// refused as unreadable.
export const MIN_TEXT_CHARS = 200;

export function hasEnoughText(text: string): boolean {
  return text.replace(/\s+/g, " ").trim().length >= MIN_TEXT_CHARS;
}

// How much document text goes to the model. Same cap as the client-profile refiner
// (lib/clients/profile.ts), which has been running on real inputs for months.
export const MAX_TEXT_CHARS = 60_000;

// ── THE TOOL SCHEMA ──
//
// Fields are declared EXPLICITLY rather than as a free-form object, so the model is shown
// exactly what it may fill and the enumerated ones carry their allowlists in the schema. The
// validator re-checks every one of these anyway -- a schema is a request, not a guarantee.
//
// TWO PROPOSABLE FIELDS ARE DELIBERATELY ABSENT:
//
// `intake_data.partnerships` is the LEGACY free-text half of a pair -- narrativeToIntakeData
// writes it as a rendering of the structured `partners`, keeping both in sync for older
// readers. An extraction that filled the text half alone would split the pair, and
// formatPartnersForDump already prefers the structured list, so there is nothing to gain.
// Structured `partners` is what the extractor proposes.
//
// `ein` and `annual_budget` are not in PROPOSABLE_FIELDS at all (a 990 is full of both) --
// that is (iii)'s decision, restated here because this is where the temptation lives.
const FIELD_PROPERTIES: Record<string, unknown> = {
  org_type: {
    type: "string",
    enum: [...ORG_TYPES],
    description:
      "The subject organization's own legal/organizational type, only if the document states it plainly (a 990 header, an incorporation line, a governmental charter). Do not infer 'nonprofit' from a document merely being about a charity.",
  },
  primary_contact_name: {
    type: "string",
    description:
      "A named individual who represents THE SUBJECT ORGANIZATION (executive director, CEO, grants contact). NEVER a preparer, auditor, attorney, consultant, or vendor.",
  },
  primary_contact_email: { type: "string", description: "Email at the subject organization." },
  primary_contact_phone: { type: "string", description: "Phone for the subject organization." },
  website: { type: "string", description: "The subject organization's own website." },
  location_street: { type: "string", description: "Street address of the subject organization." },
  location_city: { type: "string" },
  location_county: {
    type: "string",
    description: "County name without the word 'County', only if the document states it.",
  },
  location_state: { type: "string", enum: [...US_STATES], description: "Two-letter USPS code." },
  location_zip: { type: "string", description: "Five-digit ZIP." },
  primary_funding_needs: {
    type: "array",
    items: { type: "string", enum: [...PRIORITY_AREAS] },
    description:
      "The matcher-facing copy of the funding priority areas. Propose the same value you propose for intake_data.priority_areas, or omit both.",
  },
  "intake_data.funding_need": {
    type: "string",
    description: "What the organization says it needs funded, in its own terms.",
  },
  "intake_data.priority_areas": {
    type: "array",
    items: { type: "string", enum: [...PRIORITY_AREAS] },
    description: "Only areas the document actually supports. An empty list means omit the field.",
  },
  "intake_data.mission": {
    type: "string",
    description:
      "The organization's stated mission, quoted or closely paraphrased from the document. Do not compose a better one.",
  },
  "intake_data.programs": {
    type: "array",
    description: "Programs the document describes, one entry each.",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        serves: { type: "string", description: "Who it serves, as the document describes them." },
        status: { type: "string", enum: ["existing", "prospective"] },
      },
      required: ["name"],
    },
  },
  "intake_data.partners": {
    type: "array",
    description:
      "Named partner organizations and what the relationship provides. A funder is not a partner; a vendor is not a partner.",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string", description: "What the partnership entails or what they bring." },
      },
      required: ["name"],
    },
  },
  "intake_data.additional_info": {
    type: "string",
    description:
      "Facts about the organization worth keeping that no other field holds. Not analysis, not recommendations.",
  },
};

export const EXTRACTION_TOOL = {
  name: "submit_extraction",
  description:
    "Record what this document says about the subject organization. Omit anything the document does not state.",
  input_schema: {
    type: "object" as const,
    properties: {
      docType: {
        type: "string",
        description: "What kind of document this is, in your own words. E.g. 'IRS Form 990'.",
      },
      docDate: {
        type: "string",
        description:
          "The period or date the document names, AS WRITTEN ('FY2024', 'year ended June 30, 2025'). Do not convert it.",
      },
      synopsis: {
        type: "string",
        description:
          "One to three sentences: what this document is and what it establishes about the organization. No advice, no assessment of grant readiness.",
      },
      fields: {
        type: "object",
        description:
          "Profile facts found in the document. Omit any field the document does not state about the subject organization.",
        properties: FIELD_PROPERTIES,
      },
      evidence: {
        type: "object",
        description:
          "REQUIRED for every key present in `fields`, same key. A short verbatim quote from the document containing that value, including the surrounding words that show whose it is. A field you cannot quote must not be proposed.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["synopsis", "fields", "evidence"],
  },
};

// ── THE PROMPT ──
//
// Two things it is built around, both from real failure modes rather than from imagination:
//
// 1. WHOSE DETAILS ARE THESE. The single likeliest wrong extraction is a correctly-read
//    contact block belonging to the wrong organization -- the paid preparer on a 990, the
//    audit firm on financial statements, a fiscal sponsor, a registered agent. Shape
//    validation cannot catch it (the email is a valid email), so the prompt names the specific
//    blocks and the evidence quote makes what it did visible.
//
// 2. OMISSION IS A CORRECT ANSWER. Every field is optional, an absent field proposes nothing,
//    and there is no penalty anywhere in this system for returning little. The failure this
//    codebase keeps producing is invented plausible content -- an assessment nobody computed,
//    a title nobody read -- so the instruction is explicit rather than implied.
export const EXTRACTION_SYSTEM_PROMPT = `You read one uploaded document and record only what it says about ONE organization: the subject organization named in the request. You work for a US grant consulting firm; the extraction is reviewed field by field by a human before any of it reaches a client profile.

WHOSE DETAILS ARE THESE — the rule that matters most.
Documents about an organization are full of OTHER organizations' contact details, and they look identical to the subject's. Before proposing any contact detail, address, or website, find whose it is on the page. Omit it unless it belongs to the subject organization.

Blocks that are NOT the subject organization, and must never be its contact details:
- "Paid Preparer Use Only" on an IRS Form 990: the firm's name, address, phone, PTIN and firm EIN belong to the accountant.
- The letterhead, signature and address on an auditor's report or opinion letter: they belong to the audit firm.
- A fiscal sponsor, fiscal agent, or pass-through entity.
- A registered agent, attorney, bank, lender, insurer, or vendor.
- A funder or grantmaker whose award letter or logo appears.
- Board members' own employers, and any organization listed only as a partner or subrecipient.
If a document names the subject organization and a preparer, and only the preparer's phone number is on the page, there is no phone number to report. Omit it.

WHAT YOU MAY RECORD.
Only what the document states. No world knowledge, no inference from a domain name to a person, no guessing a county from a city, no completing a partial address. If the document says the organization is in Springfield and never says which state, omit the state.

EVIDENCE IS A PRECONDITION.
For every field you propose, provide a verbatim quote from the document in "evidence" under the same key, including enough surrounding words to show whose value it is. If you cannot quote it, you may not propose it. Quotes are shown to the reviewer beside the value.

OMISSION IS A CORRECT ANSWER.
Every field is optional. An omitted field proposes nothing, which is the right outcome for anything the document does not establish. Never send an empty string or an empty list — omit the key instead. Returning a synopsis and nothing else is a perfectly good extraction of a document that says little about the organization. Do not stretch to fill fields.

NEVER.
- Never assess the organization, rank its prospects, or comment on its grant readiness.
- Never propose a value in order to replace one you were shown; you are not shown the profile.
- Never restate a value you cannot attribute to the subject organization.

The synopsis says what the document IS and what it establishes about the organization, in one to three plain sentences. No advice.`;

// Which failure a thrown error from the model call is.
//
// Only two outcomes, and the distinction is whose problem it is: a missing key means the
// extractor is not configured (ours, and no document will work until it is fixed), anything
// else means this call failed (retryable). Pure so both branches are testable without an SDK
// -- the alternative was a `catch` in a server-only file that nothing here could reach.
export function extractorErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /ANTHROPIC_API_KEY/i.test(message) ? EXTRACTOR_UNAVAILABLE : EXTRACTOR_FAILED;
}

// ── THE VALIDATOR ──

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t === "" ? null : t;
};

// Per-field caps mirror lib/intake/narrative.ts's `cap` values for the intake keys, so an
// extracted value cannot be longer than one the same field accepts from a form.
const TEXT_CAPS: Record<string, number> = {
  primary_contact_name: 200,
  primary_contact_email: 320,
  primary_contact_phone: 60,
  website: 300,
  location_street: 300,
  location_city: 120,
  location_county: 120,
  "intake_data.funding_need": 2000,
  "intake_data.mission": 2000,
  "intake_data.additional_info": 2000,
};

// Deliberately loose: one @, no spaces, a dot in the domain. A stricter grammar rejects
// valid addresses, and this is not an authentication boundary -- it exists so an obvious
// non-email ("see attached", "n/a") never reaches the profile as a contact address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Filters an extracted list to the fixed option list, rather than rejecting the whole field.
// The forms do the same (parseNarrative filters priority_areas to PRIORITY_AREAS), so a
// mixed list yields the recognised subset -- and an empty result omits the field, because
// proposing [] would propose clearing it.
function allowedAreas(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const kept = v.filter((a): a is string => typeof a === "string" && PRIORITY_AREAS.includes(a));
  return kept.length ? Array.from(new Set(kept)) : null;
}

// Proposable, but NOT extractable, and the validator drops it rather than trusting the schema
// to have kept it out. `intake_data.partnerships` is the legacy free-text half of a pair whose
// other half is the structured `partners` list -- the forms write both together, so filling
// one from a document splits them. The tool schema does not offer this field; a model that
// returns it anyway must not get a different answer than one that read the schema.
const EXCLUDED_FROM_EXTRACTION: readonly string[] = ["intake_data.partnerships"];

// One extracted field -> the value that may be proposed, or null to drop it.
//
// Enumerations and formats are enforced HERE as well as in the tool schema because the schema
// is a request the model can ignore, and dropping a bad value is cheaper than a reviewer
// discovering that a ticked field silently did not save. proposal.ts refuses these at the
// writer too -- three layers, in the one place where a wrong write is unreversible.
function validateFieldValue(field: string, raw: unknown): unknown {
  switch (field) {
    case "org_type": {
      const s = str(raw, 60);
      return s && (ORG_TYPES as readonly string[]).includes(s) ? s : null;
    }
    case "primary_funding_needs":
    case "intake_data.priority_areas":
      return allowedAreas(raw);
    case "location_state": {
      const s = str(raw, 20);
      if (!s) return null;
      const up = s.toUpperCase();
      return US_STATES.includes(up) ? up : null;
    }
    case "location_zip": {
      const s = str(raw, 20);
      const m = s?.match(/^(\d{5})(?:-\d{4})?$/);
      return m ? m[1] : null;
    }
    case "primary_contact_email": {
      const s = str(raw, TEXT_CAPS.primary_contact_email);
      if (!s) return null;
      const lower = s.toLowerCase();
      return EMAIL_RE.test(lower) ? lower : null;
    }
    case "primary_contact_phone": {
      const s = str(raw, TEXT_CAPS.primary_contact_phone);
      // Ten digits is the US floor. Kept AS WRITTEN rather than reformatted: the client's own
      // form stores whatever they typed, and normalising here would make the same phone number
      // look like a change when it is not.
      return s && (s.match(/\d/g) ?? []).length >= 10 ? s : null;
    }
    case "website": {
      const s = str(raw, TEXT_CAPS.website);
      // A host with a dot and no whitespace. No scheme is added -- the client's form stores
      // what they type, and rewriting "example.org" to "https://example.org" would be this
      // module editing a value rather than validating it.
      return s && /^[^\s]+\.[^\s.]{2,}$/.test(s.replace(/^https?:\/\//i, "")) ? s : null;
    }
    // ── SHAPE PARITY BY CONSTRUCTION ──
    //
    // programs and partners are arrays of OBJECTS, and the shape is not ours to define:
    // NarrativeProgram / NarrativePartner is what both form paths write and what the portal
    // editor and the profile refiner read. So the extracted value goes through the SAME
    // parseNarrative the forms use, and we keep its output. Field names, caps, the
    // status enum and the 20-entry bound all come from there rather than being re-stated
    // here, where they could drift.
    //
    // Passed as a lone key so parseNarrative's partners-from-partnerships self-heal cannot
    // fire: it needs a `partnerships` string, and there is never one here.
    case "intake_data.programs": {
      const programs = parseNarrative({ programs: raw }).programs;
      return programs.length ? programs : null;
    }
    case "intake_data.partners": {
      const partners = parseNarrative({ partners: raw }).partners;
      return partners.length ? partners : null;
    }
    default:
      return str(raw, TEXT_CAPS[field] ?? 500);
  }
}

const EVIDENCE_MAX_CHARS = 300;

// Cut a model's raw tool input down to what may be stored.
//
// TOTAL, not best-effort: anything not explicitly kept is dropped. Unknown keys, wrong types,
// empty values, unrecognised enum members, and fields outside PROPOSABLE_FIELDS all disappear
// here rather than being repaired -- there is no shape the caller can send that produces a
// key this function did not choose to emit. That is what makes "a bad extraction is dropped,
// not written" a property rather than a hope, and it is why this file has no I/O in it: the
// whole rule set is exercised offline.
export function validateExtraction(raw: unknown): ExtractedDocument {
  const out: ExtractedDocument = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;

  const docType = str(obj.docType, 120);
  if (docType) out.docType = docType;
  const docDate = str(obj.docDate, 120);
  if (docDate) out.docDate = docDate;
  const synopsis = str(obj.synopsis, 1200);
  if (synopsis) out.synopsis = synopsis;

  const rawFields =
    obj.fields && typeof obj.fields === "object" && !Array.isArray(obj.fields)
      ? (obj.fields as Record<string, unknown>)
      : {};
  const rawEvidence =
    obj.evidence && typeof obj.evidence === "object" && !Array.isArray(obj.evidence)
      ? (obj.evidence as Record<string, unknown>)
      : {};

  // Iterating the ALLOWLIST rather than the model's keys is what makes `__proto__`,
  // `constructor` and every other unexpected key a non-event: they are never looked up, so
  // they cannot be copied, and the result's key ORDER is the allowlist's rather than the
  // model's (buildProposals re-sorts anyway, but a stable stored object diffs cleanly).
  const fields: Record<string, unknown> = {};
  const evidence: Record<string, string> = {};
  for (const field of PROPOSABLE_FIELDS) {
    if (EXCLUDED_FROM_EXTRACTION.includes(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(rawFields, field)) continue;
    const value = validateFieldValue(field, rawFields[field]);
    if (value === null || value === undefined) continue;
    fields[field] = value;
    // Evidence is kept only for a field that survived. A quote for a dropped field would be
    // provenance for a value nobody sees.
    const quote = str(rawEvidence[field], EVIDENCE_MAX_CHARS);
    if (quote) evidence[field] = quote;
  }

  if (Object.keys(fields).length) out.fields = fields;
  if (Object.keys(evidence).length) out.evidence = evidence;
  return out;
}

// Did this extraction actually find anything beyond a description of the document?
//
// Used to distinguish the two `ready` outcomes in the response, which read very differently
// to a human: "read it, it proposes nothing" vs "read it, here is what it proposes".
export function proposesNothing(extracted: ExtractedDocument): boolean {
  return !extracted.fields || Object.keys(extracted.fields).length === 0;
}
