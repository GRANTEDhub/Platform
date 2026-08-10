import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ClientDocument } from "@/types/database";

// Reading a client's documents for a page render (Pursuit step 3c).
//
// UNDER THE CALLER'S OWN RLS, not the service role, and that is the whole design of this file.
// 0075's member policy is `is_client_member_of(client_id) and client_visible`, so the policy
// itself decides what comes back -- a client cannot be shown a row the database would refuse
// them, because nothing here is in a position to over-fetch. A service-role read plus a filter
// would put that guarantee in application code, where 3b already had to learn the hard way
// that a hand-written check can be looser than the policy it replaces.
//
// The consequence, stated rather than discovered: a staff-admin sees rows via 0030's
// is_admin() policy, and a CONTRACTOR sees nothing at all. That matches every write path in
// the document layer, so the list is not a way around the billing firewall either.

// What the UI actually needs. Not `select *`: storage_bucket / storage_path are internal
// pointers and there is no reason for them to reach the browser -- opening a file goes through
// the signed-URL route, which re-authorises from the row id.
export type DocumentListItem = Pick<
  ClientDocument,
  "id" | "kind" | "title" | "content_type" | "size_bytes" | "created_at"
>;

// One definition of "what the browser is allowed to see about a document", shared with the
// confirm route so the row it returns after an upload matches the rows this list renders.
// Without that, the two paths would disagree about the shape and confirm would be the leak.
export const DOCUMENT_LIST_COLUMNS = "id, kind, title, content_type, size_bytes, created_at";

// Files a client attached to one pursuit. Draft-scoped, so org-level documents (null
// intellengine_draft_id) are excluded -- those belong to the compliance step (3d), and mixing
// them in here would show a client their firm records on a page whose upload control cannot
// create or remove them.
export async function listDraftDocuments(draftId: string): Promise<DocumentListItem[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("client_documents")
    .select(DOCUMENT_LIST_COLUMNS)
    .eq("intellengine_draft_id", draftId)
    .order("created_at", { ascending: true });
  // An empty list on failure, not a throw: this runs in a page render, and a documents query
  // that errors should cost the client their file list, not the whole scope step. Logged so it
  // is not silent -- the failure mode this brick exists to remove is the one nobody can see.
  if (error) {
    console.error(`[documents] draft list failed draft=${draftId}:`, error.message);
    return [];
  }
  return (data ?? []) as DocumentListItem[];
}
