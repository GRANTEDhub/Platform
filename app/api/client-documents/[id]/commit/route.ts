import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveDocumentActor, canReadDocument } from "@/lib/documents/authorize";
import { canAssimilateFor } from "@/lib/documents/assimilate-authorize";
import { commitProfileChanges, type AcceptedField } from "@/lib/documents/commit";
import { isProposableField } from "@/lib/documents/proposal";
import type { ClientDocument } from "@/types/database";

const MAX_NOTE_CHARS = 2000;

// Commit the profile changes a human accepted from one document's extraction.
//
// THE ONLY PATH FROM A DOCUMENT TO THE PROFILE. Extraction writes nothing but the
// extraction; this route writes the profile, and only the fields the caller explicitly
// listed as accepted. There is no "accept all" server-side shortcut, because a request
// that could say "apply everything" would let a caller commit fields the review screen
// never rendered.
//
// EVERY FIELD IS RE-VALIDATED against PROPOSABLE_FIELDS here AND again in
// commitProfileChanges. Deliberate belt and braces: the allowlist is the property that
// keeps assimilation unable to write anything a client could not type by hand, so it is
// checked at the boundary and at the writer rather than trusted in between.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { accepted?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: row } = await admin
    .from("client_documents")
    .select("id, client_id, client_visible, intellengine_draft_id")
    .eq("id", params.id)
    .maybeSingle<
      Pick<ClientDocument, "id" | "client_id" | "client_visible" | "intellengine_draft_id">
    >();
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Same pair as /extract, for the same reason. Committing does not read the file, but it
  // acts ON a document and stamps review_note onto it, and "you may annotate a document you
  // are not allowed to read" is not a rule worth having. One rule across both routes: you
  // must be able to read the document you are acting on, AND be entitled to move this org's
  // profile.
  if (!canReadDocument(actor, row) || !canAssimilateFor(actor, row.client_id)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  if (!Array.isArray(body.accepted)) {
    return NextResponse.json({ error: "accepted must be an array" }, { status: 400 });
  }
  // Unknown field names are DROPPED rather than 400'd: the review screen and this route can
  // legitimately be a deploy apart, and refusing the whole commit because one field name is
  // stale would lose the reviewer's other decisions. What is dropped is invisible to them,
  // so the response reports what actually changed instead of implying everything did.
  const accepted: AcceptedField[] = body.accepted
    .filter((a): a is { field: string; value: unknown } =>
      !!a && typeof a === "object" && isProposableField((a as { field?: unknown }).field),
    )
    .map((a) => ({ field: a.field, value: a.value }));

  if (accepted.length === 0) {
    return NextResponse.json({ error: "Nothing was selected to save." }, { status: 400 });
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE_CHARS) : null;

  // The reviewer's note is stamped on the DOCUMENT as well as copied into each audit row by
  // the writer -- on the document so re-opening it shows what the reviewer said, in the log
  // so the record survives the document being deleted.
  //
  // ALWAYS WRITTEN, never gated on truthiness. Review finding on #340: `if (note)` treated
  // null and "" as "skip", so a reviewer who cleared the textarea got the OLD note back on
  // the next load while the audit row for that commit correctly recorded null -- the document
  // and the log disagreeing, and the UI silently reverting an explicit clear. Clearing a note
  // is a decision like any other.
  await admin.from("client_documents").update({ review_note: note }).eq("id", params.id);

  const result = await commitProfileChanges({
    clientId: row.client_id,
    documentId: row.id,
    actor,
    actorEmail: actor.email,
    accepted,
    note,
  });

  if (!result.ok) {
    // 500 rather than 400: by the time this can fail, the caller's input was already
    // accepted -- what went wrong is on our side (profile write or audit write).
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    commitId: result.commitId ?? null,
    changed: result.changed ?? [],
    unchanged: result.unchanged ?? [],
    // Fields a per-field rule refused (an emptied additive-only field, an unrecognised
    // org_type). Surfaced so the screen can name them rather than showing a success that
    // quietly did less than the reviewer asked for.
    rejected: result.rejected ?? [],
  });
}
