import { requireUser } from "@/lib/auth";
import { TopNav, type NavItem } from "@/components/layout/top-nav";

// The nav is the console's frame. It holds the modules the firm runs on, but it is
// now split by HOW OFTEN a destination is used rather than listing all eleven at
// equal weight:
//
//   BAND — the daily path. Portfolio (clients) -> Ledger (opportunities) -> Matches
//          (the two match tracks) -> Prospecting -> Pipeline.
//   MORE — live but occasional (Feedback, Invoices, Contracts, Settings), then
//          genuinely unshipped (Time, Sales) below a divider, as disabled rows.
//
// The unshipped pair is Time and Sales — verified against which pages actually still
// render ComingSoon. Invoices and Contracts went live (#255) and are real
// destinations now, so they are clickable; burying live pages behind a "Soon" label
// would understate what the platform does.
const ADMIN_BAND: NavItem[] = [
  { href: "/clients", label: "Portfolio", icon: "portfolio" },
  { href: "/grants", label: "Ledger", icon: "grants" },
  { href: "/matches", label: "Matches", icon: "matching" },
  { href: "/intel", label: "Prospecting", icon: "intel" },
  { href: "/leads", label: "Pipeline", icon: "leads" },
];

const ADMIN_MORE: NavItem[] = [
  { href: "/feedback", label: "Feedback", icon: "feedback" },
  { href: "/invoices", label: "Invoices", icon: "invoices" },
  { href: "/contracts", label: "Contracts", icon: "contracts" },
  { href: "/settings", label: "Settings", icon: "settings" },
  { href: "/time", label: "Time", icon: "time", soon: true },
  { href: "/sales", label: "Sales", icon: "sales", soon: true },
];

// Contractors get grant work AND the client console: Portfolio -> a client's
// dashboard / Grant Report / IntellEngine. Invoicing & contract surfaces stay
// admin-only (Edit profile, Invoices, Contracts, the Portfolio money footer, and
// concept proposals). Prospecting / Pipeline (BizDev) remain admin-only. Nothing is
// folded into More for them — three items need no overflow.
const CONTRACTOR_BAND: NavItem[] = [
  { href: "/clients", label: "Portfolio", icon: "portfolio" },
  { href: "/grants", label: "Ledger", icon: "grants" },
  { href: "/matches", label: "Matches", icon: "matching" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";

  return (
    // COLUMN, not row: the band spans the full width edge-to-edge, so the shell's old
    // p-3/gap-3 inset (which framed the floating sidebar) is gone. Pages carry their
    // own gutters, so nothing loses padding.
    //
    // isolate: without it, this div's own bg paints in front of any descendant's
    // fixed + negative-z-index backdrop (MapBackdrop, the one that remains) -- an
    // ordinary box's background always outranks a negative z-index descendant UNLESS
    // the box establishes its own stacking context. Confirmed by direct reproduction:
    // the same fixed/-z-10 backdrop rendered invisible nested under a bg-painted
    // ancestor, and rendered fine once the ancestor had no background of its own.
    //
    // h-screen + overflow-hidden on the shell with the scroll on <main> keeps the band
    // pinned without position:fixed — so it never overlaps content and needs no
    // compensating top padding.
    <div className="isolate flex h-screen flex-col overflow-hidden bg-page">
      <TopNav
        items={isAdmin ? ADMIN_BAND : CONTRACTOR_BAND}
        more={isAdmin ? ADMIN_MORE : []}
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
