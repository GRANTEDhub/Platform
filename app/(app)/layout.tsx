import { requireUser } from "@/lib/auth";
import { TopNav, type NavItem } from "@/components/layout/top-nav";
import { pendingReviewCount } from "@/lib/matches/pending-count";

// The nav is the console's frame. It holds the modules the firm runs on, but it is
// now split by HOW OFTEN a destination is used rather than listing all eleven at
// equal weight:
//
//   BAND — the daily path, in the order the approved design draws it (see
//          design/dashboard/). Portfolio (clients) -> Ledger (opportunities) ->
//          Matches (the two match tracks) -> Prospecting -> Pipeline -> Sales.
//   MORE — live but occasional (Feedback, Invoices, Contracts, Settings), then
//          genuinely unshipped (Time) below a divider, as a disabled row.
//
// Time is the only genuinely unshipped destination left. Sales was marked `soon` and
// buried in More, but app/(app)/sales/page.tsx is a real admin route — a ComingSoon
// body behind requireAdmin, not a missing page — and the design puts it in the band, so
// the flag was simply wrong. Invoices and Contracts went live (#255) and are real
// destinations too, so they are clickable; burying live pages behind a "Soon" label
// would understate what the platform does.
//
// IntellEngine sits in the band in the design and is deliberately absent here:
// /intellengine is requireClient() and rejects staff, and there is no global staff
// index to point at (staff reach it per-client at /clients/:id/intellengine). Tracked
// rather than stubbed — see components/layout/top-nav.tsx for the full note.
const ADMIN_BAND: NavItem[] = [
  { href: "/clients", label: "Portfolio", icon: "portfolio" },
  { href: "/grants", label: "Ledger", icon: "grants" },
  { href: "/matches", label: "Matches", icon: "matching" },
  { href: "/intel", label: "Prospecting", icon: "intel" },
  { href: "/leads", label: "Pipeline", icon: "leads" },
  { href: "/sales", label: "Sales", icon: "sales" },
];

const ADMIN_MORE: NavItem[] = [
  { href: "/feedback", label: "Feedback", icon: "feedback" },
  { href: "/invoices", label: "Invoices", icon: "invoices" },
  { href: "/contracts", label: "Contracts", icon: "contracts" },
  { href: "/settings", label: "Settings", icon: "settings" },
  { href: "/time", label: "Time", icon: "time", soon: true },
];

// Contractors get grant work AND the client console: Portfolio -> a client's
// dashboard / Grant Report / IntellEngine. Nothing is folded into More for them --
// three items need no overflow, and `more` is [] so no financial surface is even
// listed for them.
//
// 0077 widened what those three doors LEAD to rather than adding doors. A contractor
// now reaches the scored Grant Report, client create/invite, pursuit documents and
// approve-and-deliver from inside Portfolio, so the band itself is unchanged.
//
// STILL ADMIN-ONLY, and this list is the money line: Invoices, Contracts, Time, the
// Portfolio money footer and the billing-rate fields on Edit profile. Prospecting /
// Pipeline / Sales stay admin-only too -- not because they are financial, but because
// COLD outreach to non-clients is a brand risk held deliberately by an admin.
// (Concept proposals were never actually contractor-blocked at the route; 0077 made
// their RLS agree with that, so they are not in this list.)
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

  // The Matches badge. Resolved here rather than inside TopNav because the band is a
  // client component and this count is a server read. It is the SAME predicate /matches
  // uses for its own worklist, so the badge and that page can never disagree — the
  // handoff calls that out explicitly. Null (query failed) renders no pill.
  const pending = await pendingReviewCount();
  const band = (isAdmin ? ADMIN_BAND : CONTRACTOR_BAND).map((item) =>
    item.href === "/matches" ? { ...item, badge: pending } : item,
  );

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
        items={band}
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
