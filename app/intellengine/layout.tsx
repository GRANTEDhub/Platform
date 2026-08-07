import { createClient } from "@/lib/supabase/server";
import { PortalHeader } from "@/components/layout/portal-header";
import { pursuitClientAccessEnabled } from "@/lib/pursuit/access";
import { getClientNotifications, type ClientNotifications } from "@/lib/portal/notifications";

type MembershipRow = { clients: { id: string; name: string } | { id: string; name: string }[] | null };

// Deliberately NOT gated here -- requireClientOrAdmin() on each page is the
// one and only auth check for this route (see the 0656605 relocation commit:
// a layout-level requireClient() redirect is exactly what made staff admins
// unreachable when these pages lived under app/portal/). This layout only
// best-effort looks up an org name to show in the shared header; a client
// member sees their org name, a staff admin previewing just sees the bare
// header (logo + sign out) -- either way sign-out is always reachable, which
// was the actual regression this fixes.
export default async function IntellEngineLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let orgName: string | null = null;
  // notifications stays null for a staff admin previewing (no membership) -- the
  // header then renders bare (logo + sign out), the same chrome as before.
  let notifications: ClientNotifications | null = null;
  if (user) {
    // Same predicate + order as requireClient()'s own lookup (lib/auth.ts) --
    // without a matching order, a user with 2+ active memberships could see a
    // different org name here than on the regular portal header, since a
    // .limit(1) query isn't guaranteed to plan the same as an unlimited one.
    const { data } = await supabase
      .from("client_members")
      .select("clients(id, name)")
      .eq("user_id", user.id)
      .not("activated_at", "is", null)
      .order("invited_at", { ascending: true })
      .limit(1)
      .maybeSingle<MembershipRow>();
    const clients = data?.clients;
    const client = Array.isArray(clients) ? clients[0] : clients;
    orgName = client?.name ?? null;
    if (client?.id) notifications = await getClientNotifications(client.id);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader orgName={orgName} notifications={notifications} showPursuit={pursuitClientAccessEnabled()} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
