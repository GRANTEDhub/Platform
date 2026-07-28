import { requireClient } from "@/lib/auth";
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
