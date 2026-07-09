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
    <aside className="flex w-60 shrink-0 flex-col rounded-3xl bg-brand-navy px-3 py-5 text-white shadow-lift">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        {/* Real TM'd mark rendered directly on navy — its dark-background variant is
            white + orange, so both read cleanly here. (No orange tile: it camouflaged
            the mark's orange elements against an identical-orange chip.) */}
        <img src="/granted-mark-dark.svg" alt="GRANTED" className="h-8 w-auto" />
        <span className="font-serif text-lg font-semibold tracking-tight text-white">GRANTED</span>
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
                  ? "bg-white/10 text-white"
                  : "text-white/55 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand-orange")} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-3">
        <div className="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-semibold text-white">
            {(user.name?.[0] || "U").toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{user.name}</p>
            <p className="text-xs capitalize text-white/50">{user.role}</p>
          </div>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="mt-1 w-full rounded-full px-4 py-2 text-left text-sm text-white/55 transition-colors hover:bg-white/5 hover:text-white"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
