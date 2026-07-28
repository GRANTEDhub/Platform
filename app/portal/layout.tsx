import { redirect } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader } from "@/components/layout/portal-header";
import { getClientNotifications } from "@/lib/portal/notifications";

// The client portal shell. Distinct from the staff (app) layout: no firm nav,
// just the client's own space. requireClient() gates it — staff are sent to
// /clients, non-members to the router. The client-facing pages (dashboard, grant
// report) build inside here in Phase 4; 3b is the shell + a bare landing.
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { memberships } = await requireClient();
  const org = memberships[0];

  // First-login gate (#16): a client whose org profile has not been confirmed is
  // sent to /welcome to review + fill it. Confirming stamps profile_confirmed_at,
  // so this fires only until they do. Reads under RLS as the client (own row).
  // Fails OPEN: if the column isn't applied yet (migration-first), the select
  // errors and data is null, so we don't redirect rather than 500 the portal.
  if (org) {
    const supabase = createClient();
    const { data: gate } = await supabase
      .from("clients")
      .select("profile_confirmed_at")
      .eq("id", org.clientId)
      .maybeSingle<{ profile_confirmed_at: string | null }>();
    if (gate && gate.profile_confirmed_at === null) redirect("/welcome");
  }

  const orgName = org?.clientName || "Your organization";
  const notifications = org ? await getClientNotifications(org.clientId) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader orgName={orgName} notifications={notifications} />
      {/* Each portal page provides its own HubShell backdrop (list = crisp,
          detail/swipe = warm), mirroring the staff roadmap surfaces. */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
