import { requireUser } from "@/lib/auth";
import { Sidebar, type NavItem } from "@/components/layout/sidebar";

// Admins see everything. Contractors are scoped to grant work only —
// no clients, time, invoices, or settings.
const ADMIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/clients", label: "Clients", icon: "clients" },
  { href: "/grants", label: "Grant Intel", icon: "grants" },
  { href: "/review", label: "Review Queue", icon: "review" },
  { href: "/time", label: "Time", icon: "time" },
  { href: "/invoices", label: "Invoices", icon: "invoices" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const CONTRACTOR_NAV: NavItem[] = [
  { href: "/grants", label: "Grant Intel", icon: "grants" },
  { href: "/review", label: "Review Queue", icon: "review" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireUser();
  const items = profile.role === "admin" ? ADMIN_NAV : CONTRACTOR_NAV;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        items={items}
        user={{
          name: profile.full_name || profile.email || "User",
          role: profile.role,
        }}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
