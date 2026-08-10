import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { resolveDocumentActor, canWriteDocument } from "@/lib/documents/authorize";
import {
  isAllowedUploadMime,
  isClientUploadKind,
  MAX_DOCUMENT_TITLE_CHARS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
} from "@/lib/documents/kinds";
import { CLIENT_UPLOADS_BUCKET, getObjectInfo, removeObjects } from "@/lib/storage";
import type { ClientDocument, IntellEngineDraft } from "@/types/database";

// Confirm an upload and record it (Pursuit step 3b).
//
// STEP TWO OF TWO. The row is written HERE, after the object has been shown to exist -- which
// is the whole reason mint and confirm are separate. No object, no row, so a document can
// never appear on a client's list without a file behind it.
//
// IT RE-AUTHORISES FROM SCRATCH. This endpoint is callable directly and must never assume
// mint ran: a caller who skips mint, or replays a path they saw once, has to fail the same
// checks again. In particular the path is proved to belong to the caller's org rather than
// taken on trust -- which is what makes the client-id-first convention in clientUploadPath
// load-bearing rather than cosmetic.
export async function POST(req: NextRequest) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { path?: unknown; kind?: unknown; title?: unknown; draftId?: unknown; clientId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (!isClientUploadKind(body.kind)) {
    return NextResponse.json({ error: "Unrecognised document type." }, { status: 400 });
  }

  const draftId = typeof body.draftId === "string" && body.draftId ? body.draftId : null;

  // Same resolution as mint: the draft's own client_id under the caller's RLS, or an explicit
  // org for staff. Never a client_id taken from a client's request body.
  let clientId: string | null = null;
  if (draftId) {
    const supabase = createClient();
    const { data: draft } = await supabase
      .from("intellengine_drafts")
      .select("id, client_id")
      .eq("id", draftId)
      .maybeSingle<Pick<IntellEngineDraft, "id" | "client_id">>();
    if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    clientId = draft.client_id;
  } else {
    // ADMIN, not merely staff: client_documents is admin-only under RLS (0030 / is_admin),
    // and this route uses the service role, so the check here IS the policy. A contractor is
    // told why rather than being handed a client-facing message.
    if (!actor.isAdmin) {
      return NextResponse.json(
        {
          error: actor.isStaff
            ? "Only an admin can file organization documents."
            : "Organization documents are managed by your GRANTED team.",
        },
        { status: 403 },
      );
    }
    clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });
  }

  if (!canWriteDocument(actor, clientId, draftId)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  // THE PATH MUST BE THIS ORG'S. clientUploadPath puts the client id first for exactly this
  // check: without it a caller could confirm a row pointing at another client's object and
  // have it listed as their own document. Compared as a full first segment, not a prefix, so
  // one client id cannot be a prefix of another's.
  if (path.split("/")[0] !== clientId) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  // NO OBJECT, NO ROW. This is the check the two-call split exists to make possible: storage
  // is asked what is actually there, and a missing object ends the request rather than being
  // recorded optimistically.
  const info = await getObjectInfo(CLIENT_UPLOADS_BUCKET, path);
  if (!info) {
    return NextResponse.json({ error: "That file didn't finish uploading. Try again." }, { status: 409 });
  }

  // Belt to the bucket's braces, and it catches the case where the two drift: if the bucket's
  // limits were ever widened past the app's, storage would accept something we do not want
  // recorded. The object is removed rather than left as an orphan we chose to create.
  if (info.contentType && !isAllowedUploadMime(info.contentType)) {
    await removeObjects(CLIENT_UPLOADS_BUCKET, [path]);
    return NextResponse.json(
      { error: "That file type isn't supported. Upload a PDF, Word or Excel document." },
      { status: 400 },
    );
  }
  if (info.size !== null && info.size > UPLOAD_MAX_BYTES) {
    await removeObjects(CLIENT_UPLOADS_BUCKET, [path]);
    return NextResponse.json({ error: `That file is over ${UPLOAD_MAX_LABEL}.` }, { status: 400 });
  }

  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  // Falls back to the uploaded file's own name rather than to something invented, so a row
  // always names the thing it points at -- but clientUploadPath prefixes a uuid to keep two
  // uploads of "audit.pdf" distinct, so that has to come off first or the fallback title reads
  // "3fa85f64-...-audit.pdf". Review finding on #330; the comment used to claim the clean name
  // while producing the storage segment.
  const segment = (path.split("/").pop() ?? "").replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
  const title = (rawTitle || segment || "Document").slice(0, MAX_DOCUMENT_TITLE_CHARS);

  // Service role for the INSERT: 0075 grants members SELECT only, deliberately, so the write
  // happens here after the checks above rather than by widening what a client may do directly.
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("client_documents")
    .insert({
      client_id: clientId,
      kind: body.kind,
      title,
      storage_bucket: CLIENT_UPLOADS_BUCKET,
      storage_path: path,
      // From STORAGE, not from what the client declared at mint. A declaration is a claim; this
      // is what the object actually is.
      content_type: info.contentType,
      size_bytes: info.size,
      intellengine_draft_id: draftId,
      // created_by references profiles(id) (0030) and a client member has no profiles row, so
      // attributing a client upload there would violate the FK. Null means "not staff-filed",
      // which is exactly what it is.
      created_by: actor.isStaff ? actor.userId : null,
      // Explicit, and the first write in the codebase to set it: 0075 defaults it false so
      // that nothing is client-readable by accident. These rows are client-facing by
      // construction -- either the client uploaded it, or staff filed it for them to see.
      client_visible: true,
    })
    .select()
    .single<ClientDocument>();

  if (error) {
    // A RETRIED CONFIRM IS A NO-OP, NOT AN ERROR. 0076 makes (storage_bucket, storage_path)
    // unique, so a second confirm of the same minted path lands here with 23505 instead of
    // creating a duplicate. Returning the existing row makes the endpoint idempotent, which is
    // what a client library retrying after a timeout needs.
    //
    // The constraint, not this branch, is what makes it safe: two concurrent confirms would
    // both pass any check we could write in application code, and only one of them can win a
    // unique index. Duplicates mattered because deleting either one removes the shared object
    // and leaves the other naming a file that no longer exists.
    if (error.code === "23505") {
      const { data: existing } = await admin
        .from("client_documents")
        .select("*")
        .eq("storage_bucket", CLIENT_UPLOADS_BUCKET)
        .eq("storage_path", path)
        .maybeSingle<ClientDocument>();
      if (existing) return NextResponse.json({ document: existing });
    }
    console.error("[client-documents] insert failed:", error.message);
    // The object is left in place rather than deleted: a retry of confirm can still record it,
    // and deleting a client's successfully-uploaded file because our own insert failed would
    // lose work we already have.
    return NextResponse.json({ error: "Couldn't record that file. Try again." }, { status: 500 });
  }

  return NextResponse.json({ document: data });
}
