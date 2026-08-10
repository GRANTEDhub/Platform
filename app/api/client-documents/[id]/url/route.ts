import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { resolveDocumentActor, canReadDocument } from "@/lib/documents/authorize";
import { signedUrl } from "@/lib/storage";
import type { ClientDocument } from "@/types/database";

// A short-lived signed URL for a document's bytes (Pursuit step 3c).
//
// WHY THIS EXISTS AT ALL: the buckets are private, so without it an uploaded file is a
// filename the client cannot open -- a claim that it arrived, with no way to check the claim.
// That is the same shape as the defect this whole brick is undoing, one step removed.
//
// SHORT-LIVED AND MINTED PER REQUEST, never stored on the row. A URL that lives in the
// database or in rendered HTML is a bearer token for the bytes that outlives the check that
// produced it; this one is minted after authorisation and expires.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Service role to READ, then judge -- same reason as the DELETE route: under the caller's
  // own RLS a forbidden row is INVISIBLE, so an RLS read would answer 404 to a request that
  // should be refused, and the two answers would be indistinguishable. client_visible is
  // selected because it is half of the authorisation decision, not decoration.
  const admin = createServiceClient();
  const { data: row } = await admin
    .from("client_documents")
    .select("id, client_id, client_visible, storage_bucket, storage_path")
    .eq("id", params.id)
    .maybeSingle<Pick<
      ClientDocument,
      "id" | "client_id" | "client_visible" | "storage_bucket" | "storage_path"
    >>();
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  if (!canReadDocument(actor, row)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  if (!row.storage_bucket || !row.storage_path) {
    return NextResponse.json({ error: "That file isn't available." }, { status: 404 });
  }

  // signedUrl returns null rather than throwing, so a missing object degrades to a clear
  // "can't open it" instead of a 500. 404, because from the caller's side the bytes are what
  // is absent -- the row's existence is not in question.
  const url = await signedUrl(row.storage_bucket, row.storage_path);
  if (!url) {
    return NextResponse.json({ error: "That file isn't available." }, { status: 404 });
  }

  return NextResponse.json({ url });
}
