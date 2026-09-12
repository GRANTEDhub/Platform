"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Search, Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import type { RosterClient, SwitcherTarget } from "@/lib/grantbot/switcher";

// The Switcher's target dropdown, in the navy panel header. Trigger shows the current target (Firm
// or a client name) + "read-only"; the menu lists Firm (admin + firm-flag only) and the searchable
// client roster.
//
// PRESENTATIONAL: the roster is owned by the Switcher (it needs it to resolve a context-default or
// deep-link client's NAME before this menu is ever opened), fetched once and passed in here — one
// source, no drift, no double fetch.
//
// The menu is PORTALED to document.body at the trigger's coords — the panel header is
// overflow-hidden (for the accent bloom) and the panel itself is overflow-hidden/rounded, so an
// in-flow dropdown would be clipped. Same escape-every-clip pattern as RationaleHoverPopover.
export function TargetPicker({
  target,
  isAdmin,
  firmEnabled,
  roster,
  loading,
  error,
  onPick,
}: {
  target: SwitcherTarget;
  isAdmin: boolean;
  firmEnabled: boolean;
  roster: RosterClient[] | null;
  loading: boolean;
  error: string | null;
  onPick: (t: SwitcherTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [q, setQ] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const showFirm = isAdmin && firmEnabled;
  const label = target.kind === "firm" ? "Firm" : target.name;

  // Close on outside pointer-down (not the trigger, not the menu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      // Clamp to the viewport so the 268px card never runs off the right edge.
      setPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left, window.innerWidth - 268 - 12)) });
    }
    setQ("");
    setOpen(true);
  }

  function pick(t: SwitcherTarget) {
    onPick(t);
    setOpen(false);
    setQ("");
  }

  const filtered = (roster ?? []).filter((c) =>
    c.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11.5px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        <span className="truncate">{label}</span>
        <span className="text-white/30">·</span>
        <span>read-only</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>

      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ position: "fixed", top: pos.top, left: pos.left, width: 268 }}
            className="z-50 flex max-h-[360px] flex-col overflow-hidden rounded-xl bg-white shadow-floating"
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {showFirm && (
                <button
                  type="button"
                  onClick={() => pick({ kind: "firm" })}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-brand-navy transition-colors hover:bg-surface-sunken"
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: BRAND.orange }} />
                  <span className="flex-1 font-medium">Firm</span>
                  {target.kind === "firm" && <Check className="h-3.5 w-3.5 shrink-0 text-brand-navy" />}
                </button>
              )}

              <div className="my-1 flex items-center gap-1.5 rounded-lg border border-edge px-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    // Keep Escape from bubbling to the Switcher's window listener (which would close
                    // the whole panel); just close the menu. React halts the native event at the root.
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpen(false);
                    }
                  }}
                  placeholder="Search clients…"
                  aria-label="Search clients"
                  autoFocus
                  className="w-full bg-transparent py-1.5 text-[12.5px] text-brand-navy outline-none placeholder:text-ink-subtle"
                />
              </div>

              {loading && (
                <p className="px-2.5 py-3 text-center text-[12px] text-ink-subtle">
                  <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
                </p>
              )}
              {error && <p className="px-2.5 py-3 text-[12px] text-red-600">{error}</p>}
              {!loading && !error && filtered.length === 0 && (
                <p className="px-2.5 py-3 text-center text-[12px] text-ink-subtle">
                  {roster && roster.length === 0 ? "No clients" : "No matches"}
                </p>
              )}
              {filtered.map((c) => {
                const active = target.kind === "client" && target.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => pick({ kind: "client", id: c.id, name: c.name })}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-sunken ${
                      active ? "text-brand-navy" : "text-brand-navy/80"
                    }`}
                  >
                    <span className="line-clamp-1 flex-1">{c.name}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-brand-navy" />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
