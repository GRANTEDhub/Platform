import "server-only";

// Turning an uploaded document into a structured summary (assimilation step (iii)).
//
// THIS SHIPS WITH A STUB, ON PURPOSE. The real extractor is an LLM call and cannot run in
// the sandbox this was built in, so extraction QUALITY is a production check on real
// documents. Building the plumbing against a deterministic stub first is what makes a
// wrong extraction land as a rejected field rather than a corrupted profile: by the time
// the shredder exists, review -> commit -> audit -> rollback is already proven.
//
// (iv) replaces `runExtraction`'s body. Nothing else in this file, and nothing that
// consumes it, should need to change -- which is the test of whether the seam is in the
// right place.
//
// The text side is already solved and battle-tested: lib/grants/nofo.ts:124-130 pulls text
// out of PDF and DOCX with pdf-parse and mammoth (both already dependencies), which is
// what (iv) will reuse rather than inventing.

// What an extraction is allowed to say. Deliberately small, and every field is OPTIONAL:
// an extractor that cannot find something must omit it, never guess. A missing field
// proposes nothing, which is the honest outcome.
export interface ExtractedDocument {
  // What kind of document this appears to be, in the extractor's own words ("IRS Form
  // 990", "audited financial statements"). Display only -- it never becomes a `kind`,
  // because kind is a client's declared choice from a fixed allowlist.
  docType?: string;
  // NO `title` FIELD, and its absence is the decision. It was declared here with the comment
  // "a better title than the filename, when the document names itself" -- and nothing ever read
  // it: the review screen wires docType, docDate and synopsis out of `extracted` but takes the
  // title from the stored client_documents.title column. So (iv) would have computed a better
  // title, stored it, and had it silently ignored. Review finding on #340.
  //
  // Removed rather than wired, because wiring it means answering a question nobody has: does
  // an extraction get to RENAME a document? The stored title is what the client sees in their
  // own list (3c), so displaying a different one on the staff screen would give one document
  // two names, and actually renaming the row is a write nobody asked for. Better an absent
  // field than a declared one with an invented consumer -- which is the failure this brick kept
  // producing. Add it back with a decision behind it if extraction-driven renaming is wanted.
  synopsis?: string;
  // AS WRITTEN IN THE DOCUMENT, and a CLAIM until a human accepts it. Kept as free text
  // rather than a date: "FY2024" and "year ended June 30, 2025" are what documents
  // actually say, and coercing them to a timestamp invents precision.
  docDate?: string;
  // The profile-shaped facts. Keys must be in PROPOSABLE_FIELDS (lib/documents/proposal.ts)
  // or they are dropped -- the allowlist is what keeps assimilation unable to write
  // anything a client could not type by hand.
  fields?: Record<string, unknown>;
}

export type ExtractionOutcome =
  | { status: "ready"; extracted: ExtractedDocument }
  | { status: "failed"; error: string };

// Content types we can get text out of at all. Excel is the known gap: the upload
// allowlist accepts spreadsheets and there is no parser in the dependency tree, so those
// FAIL HONESTLY with a message rather than yielding an empty extraction that reads like a
// document with nothing in it.
const TEXT_EXTRACTABLE = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function isTextExtractable(contentType: string | null): boolean {
  return !!contentType && TEXT_EXTRACTABLE.includes(contentType);
}

export const SPREADSHEET_UNSUPPORTED =
  "We can't read spreadsheets yet. Upload a PDF or Word version and we'll pull the details from that.";

// Run extraction for one document.
//
// STUB BEHAVIOUR: no LLM, no network, no file read. It reports `failed` for anything we
// could not get text out of -- which is the branch worth having live now, because it is the
// one a real client hits by uploading a spreadsheet -- and otherwise returns an EMPTY
// ready extraction. Empty is deliberate: a stub that invented plausible-looking fields
// would be the compliance-step fabrication all over again, one layer down.
export async function runExtraction(input: {
  contentType: string | null;
  title: string;
}): Promise<ExtractionOutcome> {
  if (!isTextExtractable(input.contentType)) {
    return { status: "failed", error: SPREADSHEET_UNSUPPORTED };
  }
  // (iv): fetch the object, pull text (pdf-parse / mammoth as in lib/grants/nofo.ts),
  // then a shape-validated LLM call filling ExtractedDocument. Until then the document is
  // recorded as extracted with nothing found, so the review screen truthfully shows no
  // proposed changes instead of a made-up summary.
  return { status: "ready", extracted: {} };
}
