import { requireUser } from "@/lib/auth";
import { Sidebar, type NavItem } from "@/components/layout/sidebar";

// Admins see the full firm. Contractors are scoped to grant work only -- no
// clients, time, invoices, contracts, sales, or settings.
//
// The nav is the admin dashboard's frame: it intentionally holds every module
// the firm runs on -- the opportunity feed, the two match tracks (client +
// prospect), CRM, time, invoicing, contracts, and sales -- even where a module
// is still a placeholder. We fill rooms in one at a time; the house is framed
// for all of them from the start.
//
// Two tracks read from one shred: Grant Matches (Track 1, active clients) and
// Grant Intel (Track 2, prospects / BizDev -- stub until the prospect engine).
const ADMIN_NAV: NavItem[] = [
  { href: "/clients", label: "Portfolio", icon: "portfolio" },
  { href: "/grants", label: "Ledger", icon: "grants" },
  { href: "/matches", label: "Matches", icon: "matching" },
  { href: "/intel", label: "Prospecting", icon: "intel" },
  { href: "/leads", label: "Pipeline", icon: "leads" },
  { href: "/time", label: "Time", icon: "time" },
  { href: "/invoices", label: "Invoices", icon: "invoices" },
  { href: "/contracts", label: "Contracts", icon: "contracts" },
  { href: "/sales", label: "Sales", icon: "sales" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

// Contractors are scoped to Track 1 grant work: the opportunity feed and the
// client match queue. Grant Intel (prospect / BizDev) is admin-only.
const CONTRACTOR_NAV: NavItem[] = [
  { href: "/grants", label: "Ledger", icon: "grants" },
  { href: "/matches", label: "Matches", icon: "matching" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireUser();
  const items = profile.role === "admin" ? ADMIN_NAV : CONTRACTOR_NAV;

  return (
    // isolate: without it, this div's own bg paints in front of any descendant's
    // fixed + negative-z-index backdrop (PageBackdrop/MapBackdrop) -- an ordinary
    // box's background always outranks a negative z-index descendant UNLESS the
    // box establishes its own stacking context. Confirmed by direct reproduction:
    // the same fixed/-z-10 backdrop rendered invisible nested under a bg-painted
    // ancestor, and rendered fine once the ancestor had no background of its own.
    <div className="isolate flex h-screen gap-3 overflow-hidden bg-brand-cream p-3">
      <Sidebar
        items={items}
        user={{
          name: profile.full_name || profile.email || "User",
          role: profile.role,
        }}
      />
      {/* scrollbar-gutter:stable reserves the scrollbar space always, so pages
          (and tab toggles) don't shift a few px when content height crosses the
          overflow threshold on one view but not the other. */}
      <main className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</main>
    </div>
  );
}
