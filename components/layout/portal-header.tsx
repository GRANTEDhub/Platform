"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./notification-bell";
import type { ClientNotifications } from "@/lib/portal/notifications";

// Shared client-facing header (logo, primary nav, notification bell, org name,
// sign out) -- used by both the client portal layout and IntellEngine's layout,
// pulled out into its own component so the two don't drift.
//
// The logo links to /portal (the client dashboard) so there's always a global
// way home. Nav + bell only render when `notifications` is non-null, i.e. a real
// client member: a staff admin previewing IntellEngine (no membership) sees just
// the bare header (logo + sign out), exactly as before.
const NAV: { href: string; label: string }[] = [
  { href: "/portal", label: "Dashboard" },
  { href: "/portal/triage", label: "Grant Alerts" },
  { href: "/portal/grants", label: "Grant Report" },
];

function isActive(pathname: string, href: string): boolean {
  // Dashboard is an exact match -- the other tabs live under /portal too, so a
  // prefix rule would light up Dashboard on every page.
  if (href === "/portal") return pathname === "/portal";
  return pathname === href || pathname.startsWith(href + "/");
}

function NavLinks({ pathname, className }: { pathname: string; className?: string }) {
  return (
    <nav className={className}>
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-brand-navy/[0.06] text-brand-navy" : "text-muted-foreground hover:text-brand-navy",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function PortalHeader({
  orgName,
  notifications,
}: {
  orgName: string | null;
  notifications: ClientNotifications | null;
}) {
  const pathname = usePathname();
  const showClientChrome = notifications !== null;

  return (
    <header className="border-b border-brand-navy/[0.06] bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/portal" aria-label="Go to dashboard">
            <img src="/granted-lockup-light.svg" alt="GRANTED" className="h-8 w-auto" />
          </Link>
          {/* Desktop nav sits inline; on mobile it drops to a scrollable second row. */}
          {showClientChrome && <NavLinks pathname={pathname} className="hidden items-center gap-1 md:flex" />}
        </div>
        <div className="flex items-center gap-3">
          {orgName && <span className="hidden text-sm font-medium text-brand-navy lg:inline">{orgName}</span>}
          {notifications && <NotificationBell count={notifications.count} items={notifications.items} />}
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
      {showClientChrome && (
        <NavLinks pathname={pathname} className="flex items-center gap-1 overflow-x-auto px-4 pb-2 md:hidden" />
      )}
    </header>
  );
}
