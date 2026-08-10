import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveDocumentActor } from "@/lib/documents/authorize";
import { canAssimilateFor } from "@/lib/documents/assimilate-authorize";
import { runExtraction } from "@/lib/documents/extract";
import type { ClientDocument } from "@/types/database";

// Run (or re-run) extraction for one document (assimilation step (iii)).
//
// SEPARATE FROM CONFIRM, on purpose. Confirm's job is "the object exists, record the row",
// and it must stay fast and certain; extraction is the slow, fallible part and will be an
// LLM call in (iv). Splitting them means a failed extraction leaves a perfectly good
// document row that can be re-extracted, rather than losing the upload.
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
  const { data: row } = await admin
    .from("client_documents")
    .select("id, client_id, title, content_type")
    .eq("id", params.id)
    .maybeSingle<Pick<ClientDocument, "id" | "client_id" | "title" | "content_type">>();
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  if (!canAssimilateFor(actor, row.client_id)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const outcome = await runExtraction({ contentType: row.content_type, title: row.title });

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
  });
}
