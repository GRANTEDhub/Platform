"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FileSearch, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// The ⌘K palette behind the command band's search field.
//
// It is a JUMP-TO, not a content search: two groups, clients and ledger grants, both
// matched on name (see app/api/search/route.ts for why the scope stops there). The
// groups are LABELLED rather than merged, so the scope is visible on screen — a single
// undifferentiated result list would imply it had searched the whole product, which is
// the same "looks live but isn't quite" problem that kept this field out of the band
// until there was something real behind it.
//
// Keyboard-first, because a palette you have to click is just a slower page: ⌘K or ⌘/
// -style entry, arrows to move, Enter to go, Escape to leave. The mouse works too.

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

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [grants, setGrants] = useState<GrantHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on every open. A palette that reopens showing the previous query's results is
  // showing stale data as if it were current.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setClients([]);
    setGrants([]);
    setActive(0);
    // rAF: the input is not mounted until this effect's render commits.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Debounced fetch. The abort matters more than the debounce: without it a slow early
  // request can land after a fast later one and overwrite good results with stale ones.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
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
  }, [query, open]);

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

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
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
          onClose();
          router.push(row.href);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, active, onClose, router]);

  if (!open) return null;

  const q = query.trim();
  let firstGrant = -1;
  rows.forEach((r, i) => {
    if (firstGrant === -1 && r.group === "grant") firstGrant = i;
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:pt-[12vh]">
      <button type="button" aria-label="Close search" onClick={onClose} className="fixed inset-0 cursor-default bg-brand-navy/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search clients and grants"
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-overlay"
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients and grants…"
            aria-label="Search clients and grants"
            className="min-w-0 flex-1 bg-transparent text-sm text-brand-navy outline-none placeholder:text-ink-faint"
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-faint" aria-hidden="true" />}
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {q.length < MIN_QUERY ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-ink-subtle">
              Type at least {MIN_QUERY} characters. Searches client names and ledger grant titles.
            </p>
          ) : rows.length === 0 && !loading ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[13px] font-medium text-brand-navy">No matches for “{q}”</p>
              {/* Says what it looked at, so an empty result is not read as "this doesn't
                  exist anywhere in the platform". */}
              <p className="mt-1 text-[11.5px] text-ink-subtle">
                Searched client names and ledger grant titles only — not NOFO text, drafts or notes.
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
                    onClick={() => {
                      onClose();
                      router.push(r.href);
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
    </div>
  );
}
