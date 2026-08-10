import "server-only";
import { createClient } from "@/lib/supabase/server";

// Who is asking, for the client-document routes (Pursuit step 3b).
//
// NOT requireClient() / requireClientOrAdmin(): those redirect(), which is page behaviour.
// A route has to answer with a status code, so this mirrors the shape
// app/api/intellengine/drafts/route.ts already uses -- getUser, then a profiles lookup to
// tell staff from client -- and returns rather than navigates.
//
// Memberships are read under the CALLER's RLS, so the list is theirs by construction: there
// is no path here where a client id the caller does not belong to can enter the set.

export interface DocumentActor {
  userId: string;
  // Any staff profile (admin or contractor). Staff manage org-level documents.
  isStaff: boolean;
  // The client orgs a client member belongs to. Empty for staff.
  clientIds: string[];
}

export async function resolveDocumentActor(): Promise<DocumentActor | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (profile) return { userId: user.id, isStaff: true, clientIds: [] };

  const { data: rows } = await supabase.from("client_members").select("client_id").eq("user_id", user.id);
  const clientIds = ((rows ?? []) as { client_id: string }[]).map((r) => r.client_id);
  return { userId: user.id, isStaff: false, clientIds };
}

// May this actor WRITE a document in this scope?
//
// THE ASYMMETRY IS THE POINT (docs/pursuit-state-audit-2026-08.md §5.1): a draft-level file is
// the client's own, but an org-level document is a staff-owned firm record. So org-level
// writes are staff-only, and a client asking for one is refused rather than quietly scoped to
// their own org -- the request is asking for something they do not get to do.
export function canWriteDocument(
  actor: DocumentActor,
  clientId: string,
  draftId: string | null,
): boolean {
  if (actor.isStaff) return true;
  if (!draftId) return false; // org-level: staff only
  return actor.clientIds.includes(clientId);
}

// May this actor DELETE this document?
//
// Same asymmetry, and the discriminator is the column itself: intellengine_draft_id non-null
// means the client uploaded it against their own pursuit and it is theirs to remove; null
// means a staffer filed it as a firm record and it is not.
export function canDeleteDocument(
  actor: DocumentActor,
  row: { client_id: string; intellengine_draft_id: string | null },
): boolean {
  if (actor.isStaff) return true;
  if (row.intellengine_draft_id === null) return false; // org-level: staff only
  return actor.clientIds.includes(row.client_id);
}
