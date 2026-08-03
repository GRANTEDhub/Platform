import { createClient } from "@/lib/supabase/server";

// Who is allowed to run "Score a grant" against a given client, and in which capacity.
//
// TWO ACTORS, ONE SCORER. Staff run it from the console client dashboard against any
// client; a portal member runs it from their own dashboard against THEIR OWN org and
// nobody else's. Both hit the same two routes (resolve -> score) and the same locked
// scorer, so the read a client gets is the read staff get -- there is no second, softer
// scoring path to keep in sync.
//
// THE CAPACITY IS THE POINT. `actor` is what the routes branch on downstream:
//   staff   may PERSIST a qualifying match onto the client's roadmap (unchanged)
//   client  is REPORT-ONLY -- a self-scored grant never writes a review_card
// A client-written card would land in their own Grant Report without ever passing the
// SME release gate, which for an account-managed client is the one invariant the whole
// portal is built around. So the capacity is decided here, once, rather than by each
// route remembering to check.
//
// `staffRole` preserves each route's EXISTING staff gate rather than unifying them:
// resolve has always been admin-only, the scorer has always accepted any staff profile.
// Opening the portal path is not a licence to quietly widen the staff path.

export type CheckGrantActor = "staff" | "client";

export type CheckGrantAccess =
  | { ok: true; actor: CheckGrantActor; userId: string }
  | { ok: false; error: string; status: 401 | 403 };

export async function resolveCheckGrantAccess(
  clientId: string,
  opts: { staffRole: "admin" | "any" },
): Promise<CheckGrantAccess> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated", status: 401 };

  // Staff = has a profiles row (the same test lib/auth.ts and the DB's is_staff() use).
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile) {
    if (opts.staffRole === "admin" && profile.role !== "admin") {
      return { ok: false, error: "Admins only", status: 403 };
    }
    return { ok: true, actor: "staff", userId: user.id };
  }

  // Portal member, and ONLY for the org they belong to. Read under the caller's own RLS
  // (0055), so this cannot be talked into confirming a membership that isn't theirs.
  const { data: member } = await supabase
    .from("client_members")
    .select("id")
    .eq("user_id", user.id)
    .eq("client_id", clientId)
    .not("activated_at", "is", null)
    .maybeSingle();
  if (member) return { ok: true, actor: "client", userId: user.id };

  return { ok: false, error: "Not authorized for this organization", status: 403 };
}
