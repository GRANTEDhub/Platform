import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

/**
 * Returns the signed-in user's STAFF profile, or null if not authenticated or not
 * staff. Middleware already redirects unauthenticated users, but pages should still
 * verify rather than assume.
 */
export async function getProfile(): Promise<Profile | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return profile;
}

/**
 * Require a signed-in STAFF user (has a profiles row). Unauthenticated → /login.
 * Authenticated but NOT staff (a client portal member has no profiles row) →
 * /portal, so a client who lands on a staff route is sent to their own space
 * rather than bounced to the login screen.
 */
export async function requireUser(): Promise<Profile> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) redirect("/portal");
  return profile as Profile;
}

/** Require an admin. Sends contractors to the review queue (their home). */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireUser();
  if (profile.role !== "admin") redirect("/review");
  return profile;
}

export interface ClientMembership {
  clientId: string;
  clientName: string;
  role: string;
}

export interface ClientSession {
  userId: string;
  email: string;
  memberships: ClientMembership[];
}

// Row shape from the client_members + clients(name) embed (Supabase types a
// to-one embed as either an object or a 1-element array; normalize both).
type MembershipRow = {
  client_id: string;
  role: string;
  clients: { name: string } | { name: string }[] | null;
};

/**
 * Require a signed-in CLIENT PORTAL member. Unauthenticated → /login. A STAFF user
 * (has a profiles row) → /clients (staff don't belong in the portal). An
 * authenticated user with no ACTIVE membership → / (the router renders a no-access
 * screen). Returns the caller's activated memberships.
 *
 * All reads here run under RLS as the caller (NOT the service role), so a client
 * can only ever see their own membership + org — the data isolation is enforced by
 * the database, not by this code.
 */
export async function requireClient(): Promise<ClientSession> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile) redirect("/clients");

  const { data: rows } = await supabase
    .from("client_members")
    .select("client_id, role, clients(name)")
    .eq("user_id", user.id)
    .not("activated_at", "is", null);

  const memberships: ClientMembership[] = ((rows ?? []) as MembershipRow[]).map((r) => ({
    clientId: r.client_id,
    clientName: Array.isArray(r.clients) ? r.clients[0]?.name ?? "" : r.clients?.name ?? "",
    role: r.role,
  }));

  if (memberships.length === 0) redirect("/");
  return { userId: user.id, email: user.email ?? "", memberships };
}
