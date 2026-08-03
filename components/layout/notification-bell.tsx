"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import type { ClientNotificationItem } from "@/lib/portal/notifications";

// Header notification bell for the client portal. State is derived server-side
// (lib/portal/notifications.ts) and passed in — this component only owns the
// open/close UI. `count` drives the badge (grant items awaiting the client);
// `items` is the full dropdown list, which may include a non-counted "From your
// team" note.
export function NotificationBell({ count, items }: { count: number; items: ClientNotificationItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count > 0 ? `Notifications, ${count} needing attention` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        // ON CHROME. Only PortalHeader mounts this, and that band is now the console's
        // dark chrome — the previous navy-on-white treatment was invisible against it.
        // Mirrors the console band's own bell (top-nav.tsx): no border, white/60 at rest.
        className="relative flex h-9 w-9 items-center justify-center rounded-sharp text-white/60 transition-colors hover:bg-white/5 hover:text-white"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand-orangeFill px-1 text-[10px] font-semibold leading-none text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-brand-navy/10 bg-white shadow-overlay"
        >
          <div className="border-b border-brand-navy/[0.06] px-4 py-3">
            <p className="text-sm font-semibold text-brand-navy">Notifications</p>
          </div>
          {items.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-1">
              {items.map((it) => {
                const body = (
                  <div className="flex flex-col gap-0.5">
                    {it.tag && (
                      <span className="text-[11px] font-medium uppercase tracking-wide text-brand-orange">{it.tag}</span>
                    )}
                    <span className="text-sm text-brand-navy">{it.title}</span>
                  </div>
                );
                return (
                  <li key={it.id}>
                    {it.href ? (
                      <Link
                        href={it.href}
                        role="menuitem"
                        onClick={() => setOpen(false)}
                        className="block px-4 py-2.5 transition-colors hover:bg-brand-cream/60"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="px-4 py-2.5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">You&rsquo;re all caught up.</p>
          )}
        </div>
      )}
    </div>
  );
}
