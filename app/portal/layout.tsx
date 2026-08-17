import { redirect } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { PortalHeader } from "@/components/layout/portal-header";
import { pursuitClientAccessEnabled, intellEngineComingSoon } from "@/lib/pursuit/access";
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
  // so this fires only until they do.
  //
  // READ VIA SERVICE-ROLE, scoped to the caller's OWN verified clientId (requireClient just proved
  // an activated membership for it). The previous RLS self-read of `clients` FAILED OPEN --
  // `if (gate && …)` only redirected when the read returned a row, so any read that came back null
  // silently SKIPPED this mandatory gate and dropped a brand-new client straight onto the portal.
  // That is the launch-day regression: new clients (UAMS/NWACC) never saw the review even though
  // their profile_confirmed_at was correctly null. Fail-open only ever made sense in the
  // migration-first window before 0065 landed; now the column is applied, so it is a hole.
  //
  // The service read returns the true value independent of RLS, so the gate is reliable and can fail
  // CLOSED: show the review unless we positively read a confirmation timestamp. It cannot over-fire
  // -- a genuinely-confirmed client has a non-null value (stamped service-role by
  // confirmClientProfileAction), so this never re-sends them.
  if (org) {
    const admin = createServiceClient();
    const { data: gate } = await admin
      .from("clients")
      .select("profile_confirmed_at")
      .eq("id", org.clientId)
      .maybeSingle<{ profile_confirmed_at: string | null }>();
    if (!gate?.profile_confirmed_at) redirect("/welcome");
  }

  const orgName = org?.clientName || "Your organization";
  const notifications = org ? await getClientNotifications(org.clientId) : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PortalHeader
        orgName={orgName}
        notifications={notifications}
        showPursuit={pursuitClientAccessEnabled()}
        comingSoon={intellEngineComingSoon()}
      />
      {/* Each portal page provides its own HubShell backdrop (list = crisp,
          detail/swipe = warm), mirroring the staff roadmap surfaces. */}
      {/* flex-1 + the scroll HERE, mirroring the staff shell: the nav band stays put and
          the body scrolls under it. flex-1 is also what gives the dashboard a definite
          height to stretch its cards into. */}
      <main className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</main>
    </div>
  );
}
