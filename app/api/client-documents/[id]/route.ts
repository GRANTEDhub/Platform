import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { resolveDocumentActor, canDeleteDocument } from "@/lib/documents/authorize";
import { removeObjects } from "@/lib/storage";
import type { ClientDocument } from "@/types/database";

// Delete a client document (Pursuit step 3b).
//
// WHO MAY DELETE WHAT: a draft-level file is the client's own upload against their own
// pursuit, and theirs to remove. An org-level document (intellengine_draft_id null) is a
// staff-owned firm record and is not client-deletable -- see canDeleteDocument, where the
// column's nullability is the discriminator.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Service role to READ, then an explicit authorisation check. Not the caller's RLS: a member
  // can only select client_visible rows, so an RLS read would make an org-level row look
  // ABSENT rather than forbidden, and the route would answer 404 to a request that should be
  // refused. Reading first and judging second keeps the two answers distinct.
  const admin = createServiceClient();
  const { data: row } = await admin
    .from("client_documents")
    .select("id, client_id, intellengine_draft_id, storage_bucket, storage_path")
    .eq("id", params.id)
    .maybeSingle<Pick<
      ClientDocument,
      "id" | "client_id" | "intellengine_draft_id" | "storage_bucket" | "storage_path"
    >>();
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  if (!canDeleteDocument(actor, row)) {
    return NextResponse.json(
      { error: "Organization documents are managed by your GRANTED team." },
      { status: 403 },
    );
  }

  // ROW FIRST, THEN OBJECT, and the order is not arbitrary. If the object delete fails we are
  // left with an invisible orphan, which is the failure we already accept as harmless. The
  // reverse order risks a row pointing at nothing -- a document that appears present with no
  // file behind it, which is the looks-received lie in its worst form. The asymmetry between
  // those two outcomes decides the sequence.
  const { error: delErr } = await admin.from("client_documents").delete().eq("id", params.id);
  if (delErr) {
    console.error(`[client-documents] delete failed id=${params.id}:`, delErr.message);
    return NextResponse.json({ error: "Couldn't remove that file. Try again." }, { status: 500 });
  }

  if (row.storage_bucket && row.storage_path) {
    // Best-effort by design (removeObjects does not throw): the row is already gone, so the
    // client's list is correct either way, and a stranded object is invisible.
    await removeObjects(row.storage_bucket, [row.storage_path]);
  }

  return NextResponse.json({ ok: true });
}
