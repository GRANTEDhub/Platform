import "server-only";
import { createClient } from "@/lib/supabase/server";

// Who is asking, for the client-document routes (Pursuit step 3b).
//
// NOT requireClient() / requireClientOrAdmin(): those redirect(), which is page behaviour.
// A route has to answer with a status code, so this mirrors the shape
// app/api/intellengine/drafts/route.ts already uses -- getUser, then a profiles lookup -- and
// returns rather than navigates.
//
// ── THESE ROUTES USE THE SERVICE ROLE, SO THEY MUST NOT BE WEAKER THAN THE RLS THEY SKIP ──
//
// Both findings below came from review on #330, and both were the same mistake in two places:
// authorising a service-role write with a check looser than the policy it bypasses. A
// service-role route is not "RLS plus a check" -- it is a check INSTEAD OF RLS, so anything
// the policy would have refused has to be refused here explicitly.
//
// 1. ROLE. `client_documents` is admin-only under RLS: 0030's policy is
//    `using (public.is_admin())`, is_admin() is `role = 'admin'` (0001), and 0066 reaffirms
//    "client_documents ... keep their is_admin() RLS" as part of the billing firewall --
//    contractors are "grant matching only, NO financial data" (0001). A bare `isStaff` check
//    included contractors, so a contractor could DELETE a row a contractor has never been
//    able to touch. And because intellengine_draft_id only exists from 0075, EVERY
//    pre-existing row is org-level -- including every kind='signed_contract' engagement
//    record. So the looser check reached exactly the legal documents the firewall is for.
//
// 2. ACTIVATION. is_client_member_of() requires `activated_at is not null` (0055), and every
//    other consumer filters on it: lib/auth.ts:103 and :143, drafts/route.ts:64,
//    check-grant-access.ts:55. The client_members_self_select policy does NOT
//    (`using (user_id = auth.uid())`), so reading memberships under the caller's own RLS
//    happily returns rows that are LINKED but never activated. That state is durable, not a
//    race: sendClientSetupLink's repair path sets user_id and deliberately leaves
//    activated_at null, so someone activated in org A and merely linked in org B would have
//    been handed org B here while every RLS-backed surface correctly refused it.

export interface DocumentActor {
  userId: string;
  // Any staff profile. Kept for readability at call sites; NOT sufficient to authorise a
  // write -- see isAdmin.
  isStaff: boolean;
  // role = 'admin'. The bar for every staff-side write, matching is_admin() at the RLS layer.
  isAdmin: boolean;
  // Client orgs this user is an ACTIVATED member of. Empty for staff.
  clientIds: string[];
}

export async function resolveDocumentActor(): Promise<DocumentActor | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // `role`, not just existence: a contractor has a profiles row too, and treating that as
  // authority is finding 1 above.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle<{ id: string; role: string }>();
  if (profile) {
    return { userId: user.id, isStaff: true, isAdmin: profile.role === "admin", clientIds: [] };
  }

  const { data: rows } = await supabase
    .from("client_members")
    .select("client_id")
    .eq("user_id", user.id)
    // Matches is_client_member_of (0055) and every sibling consumer. Without it a linked but
    // never-activated membership counts as real here and nowhere else.
    .not("activated_at", "is", null);
  const clientIds = ((rows ?? []) as { client_id: string }[]).map((r) => r.client_id);
  return { userId: user.id, isStaff: false, isAdmin: false, clientIds };
}

// May this actor WRITE a document in this scope?
//
// THE ASYMMETRY IS THE POINT (docs/pursuit-state-audit-2026-08.md §5.1): a draft-level file is
// the client's own, but an org-level document is a staff-owned firm record. So org-level
// writes are staff-only, and a client asking for one is refused rather than quietly scoped to
// their own org -- the request is asking for something they do not get to do.
//
// STAFF MEANS ADMIN HERE, at BOTH levels, because the table is admin-only under RLS and this
// route replaces RLS rather than adding to it. A contractor helping a client cannot attach a
// pursuit file through this path; if that turns out to be wanted, it is a deliberate widening
// of 0030's policy plus a migration, not something a service-role route grants on the quiet.
export function canWriteDocument(
  actor: DocumentActor,
  clientId: string,
  draftId: string | null,
): boolean {
  // 0077: a pursuit file is any staffer's to attach, because attaching it IS the
  // drafting work. ORG level is still admin-only -- that is where signed contracts
  // live, and the draft-id split is the same structural predicate the new RLS policy
  // uses, so route and policy agree by construction rather than by coincidence.
  if (actor.isStaff) return draftId !== null || actor.isAdmin;
  if (!draftId) return false; // org-level: staff only
  return actor.clientIds.includes(clientId);
}

// May this actor DELETE this document?
//
// Same asymmetry, and the discriminator is the column itself: intellengine_draft_id non-null
// means the client uploaded it against their own pursuit and it is theirs to remove; null
// means a staffer filed it as a firm record and it is not.
//
// The admin bar matters most here. Deleting is irreversible and org-level covers every
// signed_contract row in the table, so this is the call that a bare isStaff check turned into
// "a contractor may destroy an engagement contract".
export function canDeleteDocument(
  actor: DocumentActor,
  row: { client_id: string; intellengine_draft_id: string | null },
): boolean {
  // 0077, same split as canWriteDocument. Deleting a pursuit file is part of managing
  // the pursuit; deleting an ORG-level row still needs an admin, and because every
  // pre-0075 row is org-level that is what keeps a contractor away from every
  // signed_contract record in the table.
  if (actor.isStaff) return row.intellengine_draft_id !== null || actor.isAdmin;
  if (row.intellengine_draft_id === null) return false; // org-level: staff only
  return actor.clientIds.includes(row.client_id);
}

// May this actor READ this document -- i.e. be handed a signed URL to the bytes (step 3c)?
//
// NOT the same shape as write or delete, and deliberately looser: reading is where the
// org-level asymmetry REVERSES. A staffer files a client's 990 as an org document for the
// client's benefit, so the client should be able to open it; they just cannot add to or
// remove from that shelf. So there is no intellengine_draft_id branch here.
//
// `client_visible` IS THE PREDICATE, and this is the one call where it carries real weight.
// 0075 defaults it false and the member SELECT policy requires it, which is what keeps
// signed contracts behind the financial firewall -- so mirroring the policy exactly is the
// whole job of this function. A read check that only tested membership would hand a client a
// signed URL to their own engagement contract while the RLS-backed list correctly refused to
// show it, and the service-role route would be the hole. Same rule as findings 1 and 2 above:
// the check replaces the policy, so it has to BE the policy.
export function canReadDocument(
  actor: DocumentActor,
  row: { client_id: string; client_visible: boolean; intellengine_draft_id: string | null },
): boolean {
  // 0077: staff read splits on draft scope like write and delete. A contractor drafting
  // a proposal needs to OPEN the budget and prior narratives they are drafting from --
  // that was the concrete thing the old admin-only read blocked.
  //
  // ORG LEVEL REMAINS ADMIN, and this is the branch that keeps the financial firewall
  // intact: every signed_contract row is org-level, so widening read without this split
  // would have handed a contractor the contract PDFs directly. Note this is a NARROWER
  // staff rule than the client rule below -- a client may open an org-level document
  // filed for them, a contractor may not. That asymmetry is intentional: the client
  // owns the 990, the contractor is not entitled to the firm's records about them.
  if (actor.isStaff) return row.intellengine_draft_id !== null || actor.isAdmin;
  return actor.clientIds.includes(row.client_id) && row.client_visible;
}
