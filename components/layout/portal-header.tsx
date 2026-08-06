"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./notification-bell";
import { PortalSearch } from "./portal-search";
import type { ClientNotifications } from "@/lib/portal/notifications";

// Shared client-facing header (logo, primary nav, notification bell, org name,
// sign out) -- used by both the client portal layout and IntellEngine's layout,
// pulled out into its own component so the two don't drift.
//
// The logo links to /portal (the client dashboard) so there's always a global
// way home. Nav + bell only render when `notifications` is non-null, i.e. a real
// client member: a staff admin previewing IntellEngine (no membership) sees just
// the bare header (logo + sign out), exactly as before.
// IntellEngine sits beside Grant Report because that is where the client's process goes
// next: a grant they approved becomes a draft. It is NOT under /portal -- the hub has its
// own route tree and mounts this same header -- which is exactly why it belongs in the nav
// rather than only being reachable from a dashboard tile.
//
// The IntellEngine tab is conditional while Pursuit is gated off for clients
// (lib/pursuit/access.ts). The flag is read SERVER-SIDE and handed down as a prop rather
// than read here: this is a "use client" component, so process.env would be undefined at
// runtime unless the var were NEXT_PUBLIC_, which would bake it into the bundle at build
// time and make the kill switch a redeploy. Omitted entirely, not disabled -- a greyed
// tab still advertises the feature, which is the "Soon" nav link this codebase already
// rejected once.
const NAV: { href: string; label: string }[] = [
  { href: "/portal", label: "Dashboard" },
  { href: "/portal/triage", label: "Grant Alerts" },
  { href: "/portal/grants", label: "Grant Report" },
];

const PURSUIT_NAV = { href: "/intellengine", label: "IntellEngine" };

function navItems(showPursuit: boolean): { href: string; label: string }[] {
  return showPursuit ? [...NAV, PURSUIT_NAV] : NAV;
}

function isActive(pathname: string, href: string): boolean {
  // Dashboard is an exact match -- the other tabs live under /portal too, so a
  // prefix rule would light up Dashboard on every page.
  if (href === "/portal") return pathname === "/portal";
  return pathname === href || pathname.startsWith(href + "/");
}

function NavLinks({
  pathname,
  className,
  showPursuit,
}: {
  pathname: string;
  className?: string;
  showPursuit: boolean;
}) {
  return (
    <nav className={className}>
      {navItems(showPursuit).map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            // Byte-for-byte the console band's pill: same radius, padding, size and the
            // same white/10 active fill. See components/layout/top-nav.tsx.
            className={cn(
              "whitespace-nowrap rounded-sharp px-3 py-[7px] text-[13.5px] transition-colors duration-[120ms] ease-out",
              active
                ? "bg-white/10 font-semibold text-white"
                : "font-medium text-white/[0.62] hover:bg-white/5 hover:text-white",
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
  showPursuit = false,
}: {
  orgName: string | null;
  notifications: ClientNotifications | null;
  // Whether the IntellEngine tab appears. Resolved server-side by the layout from
  // pursuitClientAccessEnabled(); defaults to FALSE so a caller that forgets to pass it
  // hides the tab rather than exposing an unfinished surface.
  showPursuit?: boolean;
}) {
  const pathname = usePathname();
  const showClientChrome = notifications !== null;

  return (
    // THE CONSOLE'S COMMAND BAND, same construction: 58px, chrome, 26px gutters,
    // full-bleed rather than a centred max-w-5xl column. The dashboard masthead butts
    // straight up under it and is also chrome, so a white bar here put a seam across the
    // top of the page and made the two halves of the product look like two products.
    // The DESTINATIONS stay the client's own — matching the band is a styling decision,
    // not an argument for showing them the firm's nav.
    <header className="shrink-0 bg-brand-chrome">
      <div className="flex h-[58px] items-center justify-between gap-[26px] px-[26px]">
        <div className="flex items-center gap-[26px]">
          <Link href="/portal" aria-label="Go to dashboard" className="flex shrink-0 items-center gap-2">
            <img src="/granted-mark-dark.svg" alt="" aria-hidden="true" className="h-[23px] w-auto" />
            <span className="font-serif text-[15px] font-bold tracking-[0.03em] text-white">GRANTED</span>
          </Link>
          {/* Desktop nav sits inline; on mobile it drops to a scrollable second row. */}
          {showClientChrome && (
            <NavLinks
              pathname={pathname}
              showPursuit={showPursuit}
              className="hidden items-center gap-[2px] md:flex"
            />
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Search sits where the console's does: right-hand group, leading the band's
              controls. Gated on showClientChrome for the same reason the nav is — a staff
              admin previewing IntellEngine has no membership, so there is nothing of
              theirs to search. */}
          {showClientChrome && <PortalSearch />}
          {orgName && <span className="hidden text-[13px] font-medium text-white/[0.72] lg:inline">{orgName}</span>}
          {notifications && <NotificationBell count={notifications.count} items={notifications.items} />}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-sharp border border-white/20 px-3 py-[6px] text-[13px] text-white/[0.72] transition-colors hover:border-white/40 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
      {showClientChrome && (
        <NavLinks
          pathname={pathname}
          showPursuit={showPursuit}
          className="flex items-center gap-[2px] overflow-x-auto px-[26px] pb-2 md:hidden"
        />
      )}
    </header>
  );
}
