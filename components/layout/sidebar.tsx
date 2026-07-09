"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Target,
  Radar,
  FileSearch,
  UserPlus,
  Users,
  Clock,
  Receipt,
  FileSignature,
  TrendingUp,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  matching: Target,
  intel: Radar,
  grants: FileSearch,
  leads: UserPlus,
  clients: Users,
  time: Clock,
  invoices: Receipt,
  contracts: FileSignature,
  sales: TrendingUp,
  settings: Settings,
};

export function Sidebar({
  items,
  user,
}: {
  items: NavItem[];
  user: { name: string; role: string };
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-brand-navy/[0.06] bg-white/70 px-3 py-5">
      <div className="mb-6 flex items-center gap-2.5 px-3">
        {/* Compact mark, light variant (navy) for the light sidebar. */}
        <img src="/granted-mark-light.svg" alt="GRANTED" className="h-8 w-auto" />
        <span className="font-serif text-lg font-semibold tracking-tight text-brand-navy">GRANTED</span>
      </div>

      <nav className="flex-1 space-y-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-full px-4 py-2.5 text-[13.5px] font-medium transition-colors",
                active
                  ? "bg-brand-navy text-white shadow-softer"
                  : "text-muted-foreground hover:bg-brand-cream hover:text-brand-navy",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-3">
        <div className="flex items-center gap-3 rounded-2xl bg-brand-cream px-3 py-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-semibold text-white">
            {(user.name?.[0] || "U").toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-brand-navy">{user.name}</p>
            <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
          </div>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="mt-1 w-full rounded-full px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-brand-cream hover:text-brand-navy"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
