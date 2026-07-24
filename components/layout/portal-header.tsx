import Link from "next/link";

// Shared client-facing header (logo, optional org name, sign out) -- used by
// both the client portal layout and IntellEngine's layout. Pulled out into
// its own component so the two don't drift: IntellEngine can't reuse
// app/portal/layout.tsx directly (that layout's requireClient() call is what
// redirects staff admins away, the bug the /intellengine relocation fixed),
// but it still needs the same chrome.
//
// The logo links to /portal (the client dashboard) so there's a global way home
// from any portal page -- without it, a client who drilled into a grant detail
// had no route back to the dashboard.
export function PortalHeader({ orgName }: { orgName: string | null }) {
  return (
    <header className="border-b border-brand-navy/[0.06] bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/portal" aria-label="Go to dashboard">
          <img src="/granted-lockup-light.svg" alt="GRANTED" className="h-8 w-auto" />
        </Link>
        <div className="flex items-center gap-4">
          {orgName && <span className="hidden text-sm font-medium text-brand-navy sm:inline">{orgName}</span>}
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
  );
}
