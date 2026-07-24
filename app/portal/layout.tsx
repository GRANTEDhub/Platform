import { requireClient } from "@/lib/auth";
import { PortalHeader } from "@/components/layout/portal-header";

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
  const orgName = memberships[0]?.clientName || "Your organization";

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader orgName={orgName} />
      {/* Each portal page provides its own HubShell backdrop (list = crisp,
          detail/swipe = warm), mirroring the staff roadmap surfaces. */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
