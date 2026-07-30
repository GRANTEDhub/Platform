import type { SupabaseClient } from "@supabase/supabase-js";

// Client-facing sends are HELD until the client has a portal seat.
//
// WHY: the onboarding sequence now ends with "Invite the client to their portal", and
// that invite is the release. Grants get matched and reviewed before the client has an
// account, so an alert fired during that window would email somebody a link to a
// portal they cannot log into -- and would spend the first impression on a grant they
// have no way to act on. Worse, it happens silently: the staff UI would report "sent".
//
// The seat is the right signal rather than a new flag, because it is the same thing
// the invite creates and the same thing the client's login depends on. No migration.
//
// This gate is about WHO may be contacted; lib/email/guard.ts remains the gate for
// WHETHER this deployment may send at all (production + enabled + allowlisted). Both
// apply -- this one first, since a held send should not even be attempted.

export interface PortalGate {
  ok: boolean;
  reason: string;
}

export async function canNotifyClient(
  db: SupabaseClient,
  clientId: string,
): Promise<PortalGate> {
  const { count, error } = await db
    .from("client_members")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);

  if (error) {
    // Fail CLOSED. An unreadable membership table must not be treated as "go ahead
    // and email the client" -- the cost of a wrongly-sent client email is much higher
    // than the cost of holding one back for a retry.
    return { ok: false, reason: `couldn't verify the client's portal seat (${error.message})` };
  }
  if ((count ?? 0) === 0) {
    return {
      ok: false,
      reason: "the client has not been invited to their portal yet — held until they are",
    };
  }
  return { ok: true, reason: "" };
}
