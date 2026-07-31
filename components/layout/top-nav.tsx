"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Clock,
  FileSearch,
  FileSignature,
  LayoutGrid,
  Menu,
  MessageSquareText,
  Radar,
  Receipt,
  Settings,
  Target,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// The command band — a full-width navy bar, replacing the 240px floating sidebar.
//
// Why a top bar: the console's real content is wide (pipelines, review queues,
// two-column client detail), and a vertical rail spent a sixth of the viewport on
// eleven links that are each one click deep. Horizontal costs 58px of height for the
// same reach and gives every page its full width back.
//
// WHAT IS DELIBERATELY NOT HERE, and why — all three would be controls that look
// functional and are not, which is the same failure as the "Soon" badges this bar
// removes from the nav:
//   · Search / ⌘K palette. There is no global search backend and no palette. A live
//     input that returns nothing is worse than no input.
//   · A notification bell. NotificationBell exists but reads client-portal
//     notifications; there is no staff notification source to point it at.
//   · IntellEngine. /intellengine is requireClient() — a client surface. Staff reach
//     it per-client at /clients/:id/intellengine, so a global staff link would land
//     on a page that rejects them.

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  // Renders in the More menu as a disabled row with a "Soon" chip. Live pages are
  // never marked this way — the flag tracks whether the destination actually exists.
  soon?: boolean;
}

const ICONS: Record<string, LucideIcon> = {
  portfolio: LayoutGrid,
  matching: Target,
  intel: Radar,
  grants: FileSearch,
  leads: UserPlus,
  time: Clock,
  invoices: Receipt,
  contracts: FileSignature,
  sales: TrendingUp,
  feedback: MessageSquareText,
  settings: Settings,
};

// Shared dismiss behaviour for both menus: click outside, Escape, and a route
// change. Written once because two ad-hoc copies drift, and a menu that survives
// navigation is the bug you only notice in production.
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => close(), [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-navy";
// Entrance for both menus: fade + a 4px settle, on the one entrance curve. Nothing
// slides in from off-screen, and it is dropped entirely under prefers-reduced-motion.
// Defined as a real keyframe in globals.css, NOT with animate-in / slide-in-from-top:
// those are tailwindcss-animate utilities and that plugin is not installed, so they
// compile to nothing and would have shipped as a missing animation with no error.
const MENU_IN = "origin-top animate-menu-in";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

export function TopNav({
  items,
  more,
  user,
}: {
  // Rendered inline in the band — the destinations used daily.
  items: NavItem[];
  // Folded into "More" — live-but-occasional first, then anything unshipped.
  more: NavItem[];
  user: { name: string; role: string };
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const moreRef = useDismiss(moreOpen, () => setMoreOpen(false));
  const userRef = useDismiss(userOpen, () => setUserOpen(false));
  const navRef = useDismiss(navOpen, () => setNavOpen(false));

  // "More" reads active when the page you are on lives inside it, so the bar never
  // shows zero active items while you are somewhere real.
  const moreActive = more.some((m) => !m.soon && isActive(pathname, m.href));

  return (
    <header className="flex h-[58px] shrink-0 items-center gap-4 bg-brand-navy px-[26px]">
      <Link href="/clients" className={cn("flex shrink-0 items-center gap-2.5 rounded-md", FOCUS)}>
        <img src="/granted-mark-dark.svg" alt="" aria-hidden="true" className="h-[23px] w-auto" />
        <span className="font-serif text-[15px] font-bold tracking-[0.03em] text-white">GRANTED</span>
      </Link>

      {/* Wide: the items inline. Narrow: one hamburger holding the same list, so the
          band never wraps to two rows. */}
      <nav aria-label="Main" className="hidden min-w-0 flex-1 items-center gap-1 lg:flex">
        {items.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
        {more.length > 0 && (
          <div ref={moreRef} className="relative">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className={cn(
                "flex items-center gap-1 rounded-md px-3 py-[7px] text-[13.5px] transition-colors duration-[120ms] ease-out",
                moreActive || moreOpen
                  ? "bg-white/10 font-semibold text-white"
                  : "text-white/[0.62] hover:bg-white/5 hover:text-white",
                FOCUS,
              )}
            >
              More
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-[120ms]", moreOpen && "rotate-180")} />
            </button>
            {moreOpen && (
              <div
                role="menu"
                className={cn(
                  "absolute left-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-md bg-white py-1 shadow-overlay",
                  MENU_IN,
                )}
              >
                <MoreItems items={more} pathname={pathname} />
              </div>
            )}
          </div>
        )}
      </nav>

      <div ref={navRef} className="relative ml-auto lg:hidden">
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          aria-label="Main menu"
          className={cn("rounded-md p-2 text-white/[0.62] transition-colors hover:bg-white/5 hover:text-white", FOCUS)}
        >
          <Menu className="h-5 w-5" />
        </button>
        {navOpen && (
          <div
            role="menu"
            className={cn(
              "absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-md bg-white py-1 shadow-overlay",
              MENU_IN,
            )}
          >
            {items.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors",
                    isActive(pathname, item.href)
                      ? "font-semibold text-brand-navy"
                      : "text-ink-muted hover:bg-page hover:text-brand-navy",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
            {more.length > 0 && (
              <>
                <div className="my-1 h-px bg-hairline-strong" />
                <MoreItems items={more} pathname={pathname} />
              </>
            )}
          </div>
        )}
      </div>

      <div ref={userRef} className="relative ml-auto hidden shrink-0 lg:block">
        <button
          type="button"
          onClick={() => setUserOpen((v) => !v)}
          aria-expanded={userOpen}
          aria-haspopup="menu"
          aria-label={`Account: ${user.name}`}
          className={cn(
            "flex h-[29px] w-[29px] items-center justify-center rounded-full bg-brand-orange text-xs font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90",
            FOCUS,
          )}
        >
          {(user.name?.[0] || "U").toUpperCase()}
        </button>
        {userOpen && (
          <div
            role="menu"
            className={cn(
              "absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-md bg-white shadow-overlay",
              MENU_IN,
            )}
          >
            <div className="border-b border-hairline-strong px-3 py-2.5">
              <p className="truncate text-[13px] font-semibold text-brand-navy">{user.name}</p>
              <p className="text-[11.5px] capitalize text-ink-subtle">{user.role}</p>
            </div>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                role="menuitem"
                className="w-full px-3 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-page hover:text-brand-navy"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-[7px] text-[13.5px] transition-colors duration-[120ms] ease-out",
        active ? "bg-white/10 font-semibold text-white" : "text-white/[0.62] hover:bg-white/5 hover:text-white",
        FOCUS,
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand-orange")} />
      {item.label}
    </Link>
  );
}

// Live destinations first, then a divider, then anything unshipped. The unshipped
// rows are NOT links: they used to render as dimmed sidebar links that navigated to a
// "Coming soon" page, which reads as a broken app rather than an unbuilt feature.
function MoreItems({ items, pathname }: { items: NavItem[]; pathname: string }) {
  const live = items.filter((i) => !i.soon);
  const soon = items.filter((i) => i.soon);
  return (
    <>
      {live.map((item) => {
        const Icon = ICONS[item.icon];
        return (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors",
              isActive(pathname, item.href)
                ? "font-semibold text-brand-navy"
                : "text-ink-muted hover:bg-page hover:text-brand-navy",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
      {soon.length > 0 && (
        <>
          {live.length > 0 && <div className="my-1 h-px bg-hairline-strong" />}
          {soon.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <div
                key={item.href}
                aria-disabled="true"
                className="flex cursor-default items-center gap-2.5 px-3 py-2 text-[13px] text-ink-faint"
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
                <span className="ml-auto rounded-full bg-brand-navy/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                  Soon
                </span>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
