import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { removeObjects } from "@/lib/storage";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { STEP_ORDER, furthestStatus } from "@/lib/intellengine/drafts";
import {
  CONTENT_MAX_BYTES,
  normalizeScopeForSave,
  normalizeSectionsForSave,
  readDraftContent,
  type DraftContent,
} from "@/lib/intellengine/content";
import type { IntellEngineDraft, IntellEngineDraftStatus } from "@/types/database";

// Advance an IntellEngine draft's status (as the client moves scope -> compliance
// -> build -> complete) or rename it. RLS scopes every read/write to the caller's
// own org. Status only ever moves FORWARD -- re-opening an earlier step never
// knocks progress backward (see furthestStatus).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Pursuit is gated off for clients (lib/pursuit/access.ts). This route advances a
  // draft's status as the wizard is walked, so leaving it open would let a client drive
  // progress through steps they cannot load. Staff are unaffected.
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    status?: IntellEngineDraftStatus;
    title?: string;
    content?: { scope?: unknown; sections?: unknown };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.status && !STEP_ORDER.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // 'complete' IS NO LONGER SETTABLE (0074). status is a resume pointer -- the furthest
  // screen opened -- and "complete" is not a screen; it used to be written by the
  // builder's Continue button, which is how three clicks through empty screens produced a
  // draft the hub advertised as "Ready to submit". Whether a draft is finished is now
  // derived from its content (lib/intellengine/content.ts) and stored nowhere, so
  // accepting it here could only ever reintroduce the claim. Rejected rather than
  // silently ignored: a caller still sending it is a caller that has not been updated.
  if (body.status === "complete") {
    return NextResponse.json(
      { error: "Completion is derived from draft content, not set directly" },
      { status: 400 },
    );
  }

  // Current row (RLS pins it to the caller's org; absent -> not theirs / gone).
  const { data: current } = await supabase
    .from("intellengine_drafts")
    .select("*")
    .eq("id", params.id)
    .maybeSingle<IntellEngineDraft>();
  if (!current) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const update: { status?: IntellEngineDraftStatus; title?: string; content?: DraftContent } = {};
  if (body.status) update.status = furthestStatus(current.status, body.status);
  if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim().slice(0, 200);

  // ── Content, MERGED BY TOP-LEVEL KEY ────────────────────────────────────────────
  //
  // The scope editor sends { scope }, the builder sends { sections }, and neither may
  // clobber the other's key -- a builder save must not wipe a scope the client wrote an
  // hour earlier. Read-current-then-spread, the same merge confirmClientProfileAction uses
  // for clients.intake_data, and the reason the two editors can autosave independently.
  //
  // A key the request omits is LEFT ALONE. A key it sends is REPLACED whole: within the
  // scope object, a field the client cleared has to end up cleared, so a deep merge here
  // would resurrect exactly the text savedAt exists to keep deleted.
  if (body.content && typeof body.content === "object") {
    const now = new Date().toISOString();
    const merged = readDraftContent(current.content);

    if ("scope" in body.content) {
      const r = normalizeScopeForSave(body.content.scope, now);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      merged.scope = r.value;
    }
    if ("sections" in body.content) {
      const r = normalizeSectionsForSave(body.content.sections, now);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      merged.sections = r.value;
    }

    // Bound the WHOLE column, not just the field that arrived: five list surfaces select
    // this column (the roster pulls it for every client's drafts), so one draft's ceiling
    // is that query's ceiling. Checked post-merge because that is the value being stored.
    if (JSON.stringify(merged).length > CONTENT_MAX_BYTES) {
      return NextResponse.json(
        { error: "This draft is too large to save. Shorten a section and try again." },
        { status: 413 },
      );
    }

    update.content = merged;
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ draft: current });

  const { data, error } = await supabase
    .from("intellengine_drafts")
    .update(update)
    .eq("id", params.id)
    .select()
    .single<IntellEngineDraft>();
  if (error) return NextResponse.json({ error: "Couldn't save" }, { status: 500 });
  return NextResponse.json({ draft: data });
}

// Delete an IntellEngine proposal draft. RLS scopes the delete to the caller's
// own org (staff: any); a draft the caller can't see resolves to null -> 404.
//
// When the draft was developing a matched grant (card_id set) that is still
// routed to IntellEngine, return that grant to the client's Grant Report as an
// undecided match -- pursuit_path back to null + decision back to 'pending',
// mirroring the review route's "clear pursuit" write. Otherwise deleting the
// proposal would strand the card as "routed to IntellEngine, but no draft".
// Both columns are client-permitted (guard_card_approval's client branch
// whitelists decision + pursuit_path), so this works for a client member too.
// Best-effort: the draft is already gone, so a hiccup there must not fail the
// delete the user asked for.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: draft } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id")
    .eq("id", params.id)
    .maybeSingle<Pick<IntellEngineDraft, "id" | "card_id">>();
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  // COLLECT THE FILE OBJECTS BEFORE THE DELETE, because the delete destroys the pointers to
  // them. client_documents.intellengine_draft_id is ON DELETE CASCADE (0075), so removing this
  // draft removes its document rows -- and nothing else in the system knows those objects
  // existed. Without this the bucket fills with unreachable files, invisibly. Same shape as
  // app/(app)/clients/actions.ts, which collects storage pointers before deleting a client.
  //
  // Read under the SERVICE role, scoped to the draft id the caller's RLS just proved they can
  // see: 0075 grants members SELECT only on client_visible rows, so a client-RLS read here
  // would silently miss a staff-filed draft-level document and orphan exactly the file the
  // client cannot see.
  const svc = createServiceClient();
  const { data: docRows } = await svc
    .from("client_documents")
    .select("storage_bucket, storage_path")
    .eq("intellengine_draft_id", params.id);
  const objects = ((docRows ?? []) as { storage_bucket: string | null; storage_path: string | null }[])
    .filter((d): d is { storage_bucket: string; storage_path: string } => !!d.storage_bucket && !!d.storage_path);

  const { error: delErr } = await supabase.from("intellengine_drafts").delete().eq("id", params.id);
  if (delErr) return NextResponse.json({ error: "Couldn't delete this proposal" }, { status: 500 });

  // After the row delete succeeded, so a failed delete never removes files that are still
  // referenced. Best-effort: the rows are gone regardless, and a stranded object is invisible.
  if (objects.length > 0) {
    const byBucket = new Map<string, string[]>();
    for (const o of objects) {
      const list = byBucket.get(o.storage_bucket);
      if (list) list.push(o.storage_path);
      else byBucket.set(o.storage_bucket, [o.storage_path]);
    }
    for (const [bucket, paths] of byBucket) {
      await removeObjects(bucket, paths);
    }
  }

  if (draft.card_id) {
    const { error: resetErr } = await supabase
      .from("review_cards")
      .update({ pursuit_path: null, decision: "pending", decided_at: null, decided_by: null, decided_by_actor: null })
      .eq("id", draft.card_id)
      .eq("pursuit_path", "intellengine");
    if (resetErr) {
      // Non-fatal: the draft is deleted; the grant just keeps its routing and can
      // be re-cleared later. Log for visibility rather than failing the request.
      console.error(`[intellengine-draft-delete] card un-route failed card=${draft.card_id}:`, resetErr.message);
    }
  }

  return NextResponse.json({ ok: true });
}
