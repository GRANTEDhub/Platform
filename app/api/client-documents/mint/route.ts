import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { resolveDocumentActor, canWriteDocument } from "@/lib/documents/authorize";
import {
  isAllowedUploadMime,
  isClientUploadKind,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
} from "@/lib/documents/kinds";
import { CLIENT_UPLOADS_BUCKET, clientUploadPath, createSignedUploadUrl } from "@/lib/storage";
import type { IntellEngineDraft } from "@/types/database";

// Mint a one-object upload URL (Pursuit step 3b, docs/pursuit-state-audit-2026-08.md §5.1).
//
// STEP ONE OF TWO, AND IT WRITES NOTHING. The client PUTs to the returned URL and then calls
// POST /api/client-documents to confirm; only that second call inserts a row. Splitting them
// is what makes "a document row cannot exist without its object" true -- a single
// insert-then-upload route would leave a row claiming a file that never arrived, which is the
// looks-received lie moved from the UI into the database.
//
// WHY A SIGNED URL AT ALL: a 990 or an audit routinely exceeds the ~4.5MB a Vercel serverless
// body can carry, so the bytes must bypass us. Authorisation stays here -- storage has no
// authenticated policy on this bucket, so an object can only be written by someone we minted
// a URL for.
export async function POST(req: NextRequest) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // The upload surfaces live behind the Pursuit gate, and hiding a control does not close the
  // endpoint under it. 404 rather than 403, matching the pages: the route is meant to look
  // absent to a client who cannot reach the feature. Staff unaffected.
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    kind?: unknown;
    fileName?: unknown;
    contentType?: unknown;
    sizeBytes?: unknown;
    draftId?: unknown;
    clientId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Kind first: 'signed_contract' is not in the allowlist, so this is where a client trying to
  // file something as a contract is refused -- independently of 0075's client_visible default.
  if (!isClientUploadKind(body.kind)) {
    return NextResponse.json({ error: "Unrecognised document type." }, { status: 400 });
  }
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  if (!fileName) return NextResponse.json({ error: "A file name is required." }, { status: 400 });

  // Declared, not verified -- the bucket enforces both for real (0075), because we never see
  // the bytes. Checking here buys the client a specific refusal before they spend minutes
  // uploading something storage would reject at the end.
  if (!isAllowedUploadMime(body.contentType)) {
    return NextResponse.json(
      { error: "That file type isn't supported. Upload a PDF, Word or Excel document." },
      { status: 400 },
    );
  }
  if (typeof body.sizeBytes === "number" && body.sizeBytes > UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: `That file is over ${UPLOAD_MAX_LABEL}.` }, { status: 400 });
  }

  const draftId = typeof body.draftId === "string" && body.draftId ? body.draftId : null;

  // WHERE clientId COMES FROM, and it is never simply trusted from the body for a client.
  //   draft-level -> read the draft under the CALLER's RLS and take its client_id. For a
  //                  client member that read is the ownership proof: another org's draft does
  //                  not resolve, so there is nothing to authorise against.
  //   org-level   -> staff only, and the target org must be explicit (same shape as the
  //                  drafts POST route, where staff act on a client's behalf).
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
    if (!actor.isStaff) {
      return NextResponse.json(
        { error: "Organization documents are managed by your GRANTED team." },
        { status: 403 },
      );
    }
    clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });
  }

  if (!canWriteDocument(actor, clientId, draftId)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const path = clientUploadPath({ clientId, draftId, fileName });
  try {
    const { signedUrl, token } = await createSignedUploadUrl(CLIENT_UPLOADS_BUCKET, path);
    // The path is returned so confirm can be told exactly which object to look for. Confirm
    // re-derives authorisation from it rather than trusting that this route ran.
    return NextResponse.json({ signedUrl, token, path, bucket: CLIENT_UPLOADS_BUCKET });
  } catch (e) {
    console.error("[client-documents/mint] signed upload URL failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't start the upload. Try again." }, { status: 500 });
  }
}
