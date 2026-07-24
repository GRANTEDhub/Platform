import { createClient } from "@/lib/supabase/server";
import { PortalHeader } from "@/components/layout/portal-header";

type MembershipRow = { clients: { name: string } | { name: string }[] | null };

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
  if (user) {
    const { data } = await supabase
      .from("client_members")
      .select("clients(name)")
      .eq("user_id", user.id)
      .not("activated_at", "is", null)
      .limit(1)
      .maybeSingle<MembershipRow>();
    const clients = data?.clients;
    orgName = (Array.isArray(clients) ? clients[0]?.name : clients?.name) ?? null;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader orgName={orgName} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
