import { requireClient } from "@/lib/auth";
import { interTight, sourceSerif } from "@/lib/fonts";

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
    <div className={`${interTight.variable} ${sourceSerif.variable} min-h-screen bg-brand-cream font-tight`}>
      <header className="border-b border-brand-navy/[0.06] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <img src="/granted-lockup-light.svg" alt="GRANTED" className="h-8 w-auto" />
          <div className="flex items-center gap-4">
            <span className="hidden text-sm font-medium text-brand-navy sm:inline">{orgName}</span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-full border border-brand-navy/15 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:border-brand-navy/30 hover:text-brand-navy"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
