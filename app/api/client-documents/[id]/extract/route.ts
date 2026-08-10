import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveDocumentActor, canReadDocument } from "@/lib/documents/authorize";
import { canAssimilateFor } from "@/lib/documents/assimilate-authorize";
import { runExtraction } from "@/lib/documents/extract";
import { proposesNothing } from "@/lib/documents/extract-shape";
import type { Client, ClientDocument } from "@/types/database";

// A PDF parse plus one model pass. Without this the platform default (15s) kills every real
// extraction and the browser sees a 504 with nothing recorded on the row -- the failure mode
// this route's whole error-recording design exists to avoid. Same value as every other
// LLM-backed route here.
export const maxDuration = 300;

// Run (or re-run) extraction for one document (assimilation step (iv)).
//
// SEPARATE FROM CONFIRM, on purpose, and (iv) is where that pays: confirm's job is "the object
// exists, record the row" and stays fast and certain, while extraction is now a storage read, a
// PDF parse and a model call -- slow and fallible. Splitting them means a failed extraction
// leaves a perfectly good document row that can be re-extracted, rather than losing the upload.
//
// RE-RUNNABLE IS THE POINT of retaining the raw file at all. Nothing here is destructive:
// it overwrites the extraction, never the profile. The profile only ever moves through the
// commit route, after a human has looked.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Service role to READ then judge -- under the caller's own RLS a forbidden row is
  // invisible, so an RLS read would answer 404 where it should answer 403 and the two
  // would be indistinguishable. Same reason the delete and signed-URL routes do it.
  const admin = createServiceClient();
  // storage_bucket / storage_path are new to this select in (iv): the stub read no bytes, and
  // the real extractor reads the object. `kind` rides along as context for the prompt (what the
  // uploader FILED it as, never as a fact about the contents).
  const { data: row } = await admin
    .from("client_documents")
    .select(
      "id, client_id, title, kind, content_type, client_visible, intellengine_draft_id, storage_bucket, storage_path",
    )
    .eq("id", params.id)
    .maybeSingle<
      Pick<
        ClientDocument,
        | "id" | "client_id" | "title" | "kind" | "content_type" | "client_visible"
        | "intellengine_draft_id" | "storage_bucket" | "storage_path"
      >
    >();
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // ── TWO CHECKS, BECAUSE THIS DOES TWO THINGS ──
  //
  // Review finding on #340 (vercel[bot]), and correct: canAssimilateFor alone was looser than
  // the read path. It asks "may you affect this org's profile", which a client member and a
  // contractor both can -- but extraction READS THE DOCUMENT, and canReadDocument is the
  // predicate that mirrors 0075's client_visible and 0077's org/draft split. Gated on the
  // profile check alone, extraction would become a content-read channel around the
  // signed-URL route: a client member could extract their own org's signed_contract row
  // (org-level, client_visible false) and a contractor could extract org-level documents,
  // both of which canReadDocument refuses outright.
  //
  // Today the stub reads no bytes, so what leaked was only a WRITE to a row the caller cannot
  // read -- flipping extraction_status on a contract. Small. But (iv) makes runExtraction read
  // the file and return a synopsis, and the hole becomes a real one at exactly the moment
  // nobody is looking at this route. It belongs to the route, not to the prompt, so it is
  // fixed here.
  //
  // Both are required and neither implies the other: read authority bounds what content you
  // can see, profile authority bounds whose profile you can move.
  if (!canReadDocument(actor, row) || !canAssimilateFor(actor, row.client_id)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  // WHO THE DOCUMENT IS SUPPOSED TO BE ABOUT. The extractor needs the subject org's identity
  // to answer "whose contact details are these" -- the paid-preparer block on a 990 is the
  // likeliest wrong extraction there is, and it is unanswerable without knowing who the client
  // is. Name plus a coarse location only; runExtraction deliberately takes no contact fields.
  const { data: client } = await admin
    .from("clients")
    .select("name, location_city, location_state, location_county")
    .eq("id", row.client_id)
    .maybeSingle<Pick<Client, "name" | "location_city" | "location_state" | "location_county">>();
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const outcome = await runExtraction({
    subject: {
      name: client.name,
      city: client.location_city,
      state: client.location_state,
      county: client.location_county,
    },
    title: row.title,
    kind: row.kind,
    contentType: row.content_type,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
  });

  // A FAILURE IS RECORDED, NOT SWALLOWED. Writing the error onto the row is what turns
  // "this document produced nothing" into "we could not read this document, and here is
  // why" -- the difference a client actually needs when they upload a spreadsheet.
  const patch =
    outcome.status === "ready"
      ? {
          extraction_status: "ready",
          extracted: outcome.extracted,
          extracted_at: new Date().toISOString(),
          extraction_error: null,
        }
      : {
          extraction_status: "failed",
          extracted: {},
          extracted_at: new Date().toISOString(),
          extraction_error: outcome.error,
        };

  const { error } = await admin.from("client_documents").update(patch).eq("id", params.id);
  if (error) {
    console.error("[assimilation] extraction write failed:", error.message);
    return NextResponse.json({ error: "Couldn't save the extraction. Try again." }, { status: 500 });
  }

  return NextResponse.json({
    status: patch.extraction_status,
    extracted: patch.extracted,
    error: outcome.status === "failed" ? outcome.error : null,
    // THE TWO `ready` OUTCOMES ARE NOT THE SAME THING, and the banner must not say "Extracted."
    // to both. "We read it and it proposes nothing" is a fine result; "we could not read it"
    // is a failure with its own message. This flag is what keeps the third case -- read it,
    // found nothing to propose -- from being reported as if fields were waiting.
    foundNothing: outcome.status === "ready" ? proposesNothing(outcome.extracted) : false,
  });
}
