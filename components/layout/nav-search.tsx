"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FileSearch, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// The command band's search: an inline field that you type into directly, with results
// dropping beneath it. Not a modal — an overlay for a lookup this small put a whole
// dialog between the intent and the answer.
//
// It is a JUMP-TO, not a content search: two groups, clients and ledger grants, both
// matched on name (see app/api/search/route.ts for why the scope stops there). The
// groups are LABELLED rather than merged, so the scope is visible on screen — a single
// undifferentiated list would imply it had searched the whole product, which is the same
// looks-live-but-isn't problem that kept this field out of the band until there was
// something real behind it.
//
// Keyboard: type to search, arrows to move, Enter to go, Escape to clear and close.
// ⌘K focuses the field from anywhere. That binding is deliberately UNADVERTISED — the
// chip that used to sit in the field was noise for a shortcut most people will not use,
// and the field is discoverable on its own. It costs nothing to leave working for anyone
// who reaches for it.

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

type ClientHit = {
  id: string;
  name: string;
  org_type: string | null;
  location_city: string | null;
  location_state: string | null;
  pipeline_stage: string | null;
};

type GrantHit = {
  id: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
};

type Row = { key: string; href: string; label: string; sub: string | null; group: "client" | "grant" };

export function NavSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [grants, setGrants] = useState<GrantHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  // The dropdown is open when there is a query worth showing results for AND the field
  // has focus. Blurring should not leave a floating result list over the page.
  const open = focused && q.length >= MIN_QUERY;

  function reset() {
    setQuery("");
    setClients([]);
    setGrants([]);
    setActive(0);
  }

  // Click outside closes and clears. Without the clear, refocusing the field would show
  // the previous query's results as if they were current.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setFocused(false);
        reset();
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ⌘K / Ctrl-K focuses the field from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced fetch. The abort matters more than the debounce: without it a slow early
  // request can land after a fast later one and overwrite good results with stale ones.
  useEffect(() => {
    if (q.length < MIN_QUERY) {
      setClients([]);
      setGrants([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json().catch(() => ({}));
        setClients(data.clients ?? []);
        setGrants(data.grants ?? []);
        setActive(0);
      } catch {
        // Aborted or failed: leave the previous results rather than blanking the list
        // under someone mid-type.
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q]);

  const rows = useMemo<Row[]>(
    () => [
      ...clients.map((c) => ({
        key: `c:${c.id}`,
        href: `/clients/${c.id}`,
        label: c.name,
        sub:
          [c.org_type?.replace(/_/g, " "), [c.location_city, c.location_state].filter(Boolean).join(", ")]
            .filter(Boolean)
            .join(" · ") || null,
        group: "client" as const,
      })),
      ...grants.map((g) => ({
        key: `g:${g.id}`,
        href: `/grants/${g.id}`,
        label: g.title || "Untitled grant",
        sub: g.funder ?? null,
        group: "grant" as const,
      })),
    ],
    [clients, grants],
  );

  function go(href: string) {
    setFocused(false);
    reset();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      reset();
      inputRef.current?.blur();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    }
    if (e.key === "Enter") {
      const row = rows[active];
      if (row) {
        e.preventDefault();
        go(row.href);
      }
    }
  }

  let firstGrant = -1;
  rows.forEach((r, i) => {
    if (firstGrant === -1 && r.group === "grant") firstGrant = i;
  });

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          "flex h-8 w-[270px] items-center gap-2 rounded-md bg-white/[0.08] px-2.5 transition-colors duration-[120ms] ease-out",
          focused ? "bg-white/[0.14]" : "hover:bg-white/[0.12]",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-white/[0.45]" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={onKeyDown}
          placeholder="Search"
          aria-label="Search clients and grants"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/[0.45]"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/[0.45]" aria-hidden="true" />}
      </div>

      {/* Right-aligned to the field: the list is wider than the field so titles have room,
          and the field sits near the right edge of the band, so anchoring left would push
          it off-screen. */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[360px] overflow-hidden rounded-md bg-white shadow-overlay">
          <div className="max-h-[60vh] overflow-y-auto">
            {rows.length === 0 && !loading ? (
              <div className="px-4 py-4 text-center">
                <p className="text-[13px] font-medium text-brand-navy">No matches for “{q}”</p>
                {/* Says what it looked at, so an empty result is not read as "this does
                    not exist anywhere in the platform". */}
                <p className="mt-1 text-[11.5px] text-ink-subtle">
                  Searched client names and ledger grant titles only.
                </p>
              </div>
            ) : (
              <ul className="py-1">
                {rows.map((r, i) => (
                  <li key={r.key}>
                    {(i === 0 || i === firstGrant) && (
                      <p className="px-4 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.11em] text-ink-subtle">
                        {r.group === "client" ? "Clients" : "Ledger grants"}
                      </p>
                    )}
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      // onMouseDown, not onClick: the wrapper's mousedown-outside handler
                      // and a click handler race, and blur can tear the row down before
                      // the click lands.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        go(r.href);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
                        i === active ? "bg-page" : "hover:bg-page/60",
                      )}
                    >
                      {r.group === "client" ? (
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                      ) : (
                        <FileSearch className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-brand-navy">{r.label}</span>
                        {r.sub && <span className="block truncate text-[11.5px] text-ink-subtle">{r.sub}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
