import "server-only";

// PERFORMING an extraction (assimilation step (iv)): storage read -> text -> one LLM call ->
// validateExtraction. Composition only.
//
// ── WHERE THE DECISIONS ARE, AND WHY NOT HERE ──
//
// Nothing in this file can run in the sandbox it was written in: no LLM egress, no storage
// credentials. So every rule worth testing was moved to lib/documents/extract-shape.ts, which
// is pure -- the field allowlist, the enum and format checks, the file-type routing, the text
// floor, the failure messages, the prompt, the tool schema. Those are exercised offline
// against the module as compiled. What is left below is the sequence, and the sequence is
// what a real document on a real deploy proves.
//
// EXTRACTION QUALITY IS NOT VERIFIABLE FROM HERE, and no green check in this repository
// should be read as evidence of it. That was the argument for shipping (iii) against a stub
// first: by the time this file does anything, review -> commit -> audit -> rollback is already
// proven, so a wrong extraction lands as a declined proposal rather than a corrupted profile.
//
// WHAT THIS WRITES: nothing but the extraction. The profile moves only through the commit
// route, only for fields a human ticked, and (iv) ships with nothing pre-ticked.

import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_TOOL,
  EXTRACTOR_FAILED,
  EXTRACTOR_TRUNCATED,
  DOWNLOAD_FAILED,
  MAX_TEXT_CHARS,
  NO_TEXT_FOUND,
  PARSE_FAILED,
  extractorErrorMessage,
  hasEnoughText,
  parseableKind,
  unsupportedMessage,
  validateExtraction,
  type ExtractedDocument,
  type ParseableKind,
} from "@/lib/documents/extract-shape";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { downloadObject } from "@/lib/storage";

// Re-exported because ExtractionOutcome below is written in terms of it. Nothing else is
// re-exported from here: the shape module is importable directly, and a convenience alias with
// no consumer is the declared-but-unread field this brick has already produced twice.
export type { ExtractedDocument };

export type ExtractionOutcome =
  | { status: "ready"; extracted: ExtractedDocument }
  | { status: "failed"; error: string };

// One model pass per document. No chunking, no map-reduce: a document that does not fit is
// refused with EXTRACTOR_TRUNCATED rather than summarised in pieces, because a partial
// extraction is indistinguishable from a complete one once it is stored.
const MAX_OUTPUT_TOKENS = 3000;
// Bounded so a hung call fails HONESTLY inside the route's maxDuration=300 -- recorded on the
// row with a message -- rather than being killed by the platform, which would leave the
// document in whatever state it was already in with nothing written to explain why.
const CALL_TIMEOUT_MS = 100_000;

// Text out of the bytes. Both parsers are already dependencies and already carry this exact
// job in lib/grants/nofo.ts; the import shape (default vs namespace) is copied from there
// because it is the shape that survived bundling.
async function parseText(buf: Buffer, kind: ParseableKind): Promise<string | null> {
  try {
    if (kind === "pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      return (await pdfParse(buf)).text ?? null;
    }
    const mammothMod = await import("mammoth");
    const mammoth = mammothMod.default ?? mammothMod;
    return (await mammoth.extractRawText({ buffer: buf })).value ?? null;
  } catch (err) {
    // Password-protected, truncated, or not the format its extension claims. Logged because
    // a systematic parse failure across many uploads is our problem, not the client's.
    console.error(
      "[assimilation] parse failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Identity anchors for the prompt: enough to decide WHOSE details are on the page.
//
// Contact name, email and phone are deliberately NOT passed. Those are the three fields most
// likely to be extracted from the wrong organization (a 990's paid-preparer block), so they
// are the three where a reviewer most needs the model's answer to be independent of what the
// profile already says. Showing them invites confirmation of an existing value; withholding
// them costs nothing, because a value equal to the current one proposes nothing anyway.
export interface ExtractionSubject {
  name: string;
  city?: string | null;
  state?: string | null;
  county?: string | null;
}

function renderRequest(input: {
  subject: ExtractionSubject;
  title: string;
  kind: string | null;
  text: string;
}): string {
  const where = [input.subject.city, input.subject.county, input.subject.state]
    .filter(Boolean)
    .join(", ");
  return [
    `SUBJECT ORGANIZATION: ${input.subject.name}`,
    where ? `Known location (for deciding whose details are whose — not a value to report): ${where}` : "",
    `Uploaded as: ${input.title}${input.kind ? ` (filed as ${input.kind})` : ""}`,
    "",
    "DOCUMENT TEXT:",
    input.text.slice(0, MAX_TEXT_CHARS),
  ]
    .filter(Boolean)
    .join("\n");
}

// Run (or re-run) extraction for one document. Never throws: every failure is an outcome the
// route records on the row, because "we could not read this document, and here is why" is
// what a person needs and a thrown error is not.
export async function runExtraction(input: {
  subject: ExtractionSubject;
  title: string;
  kind: string | null;
  contentType: string | null;
  storageBucket: string | null;
  storagePath: string | null;
}): Promise<ExtractionOutcome> {
  const kind = parseableKind(input.contentType, input.storagePath);
  if (!kind) {
    return { status: "failed", error: unsupportedMessage(input.contentType, input.storagePath) };
  }
  // A row with no pointer cannot be read. 3b writes the pointer before the row exists, so this
  // is a broken row rather than a normal state -- but it must not throw in a route.
  if (!input.storageBucket || !input.storagePath) {
    return { status: "failed", error: DOWNLOAD_FAILED };
  }

  let buf: Buffer;
  try {
    buf = await downloadObject(input.storageBucket, input.storagePath);
  } catch (err) {
    console.error(
      "[assimilation] download failed:",
      err instanceof Error ? err.message : err,
    );
    return { status: "failed", error: DOWNLOAD_FAILED };
  }

  const text = await parseText(buf, kind);
  if (text === null) return { status: "failed", error: PARSE_FAILED };

  // THE SCAN CASE, and it fails rather than proceeding. A picture of text parses to nothing,
  // and nothing is what the model would then honestly find -- landing as `ready` with no
  // proposals, which the review screen states as "the extraction found no profile details
  // this document could add". That sentence would be false: the document may hold exactly
  // what we wanted and we cannot see any of it. Checked BEFORE the call, so it also cannot
  // spend a model call on an empty page.
  if (!hasEnoughText(text)) return { status: "failed", error: NO_TEXT_FOUND };

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: EXTRACTION_SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        // Forced, as in every other structured call here: the only acceptable output is the
        // tool shape, so prose about the document is not a thing that can happen.
        tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
        messages: [{ role: "user", content: renderRequest({ ...input, text }) }],
      },
      // One retry rather than the SDK default of two: two 100s attempts plus the parse still
      // fit inside maxDuration=300, three do not, and being killed mid-call records nothing.
      { timeout: CALL_TIMEOUT_MS, maxRetries: 1 },
    );

    if (response.stop_reason === "max_tokens") {
      return { status: "failed", error: EXTRACTOR_TRUNCATED };
    }
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return { status: "failed", error: EXTRACTOR_FAILED };
    }
    // The ONLY path from model output to storage, and it drops everything it did not choose
    // to keep. A hostile or malformed tool input is a smaller extraction, never a wider one.
    return { status: "ready", extracted: validateExtraction(toolUse.input) };
  } catch (err) {
    console.error(
      "[assimilation] extractor call failed:",
      err instanceof Error ? err.message : err,
    );
    return { status: "failed", error: extractorErrorMessage(err) };
  }
}
