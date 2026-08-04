"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSearch, FileText, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_LABEL } from "@/lib/intellengine/drafts";
import type { IntellEngineDraftStatus } from "@/types/database";

// The client band's search — the portal counterpart of NavSearch, and deliberately the
// SAME control: same 270px field, same white/8 fill, same debounce, same keyboard
// handling, same right-anchored 360px dropdown. The two bands are meant to be one piece
// of chrome, so a client should not be able to tell which of the two products styled it.
//
// WHAT DIFFERS IS THE SCOPE, and only because the two actors own different things. Staff
// jump to clients and ledger grants; a client jumps to THEIR grants — every grant ever
// matched to them, including ones they passed on — and their IntellEngine proposals. The
// enforcement of that scope is in RLS and the API route, not here; see
// app/api/portal/search/route.ts.
//
// Each grant row carries the state it sits in (Awaiting your review / In your Grant Report
// / Approved / Passed). A jump-to that drops you on a grant you closed months ago without
// saying so reads as the search being wrong rather than the record being old.

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

type GrantHit = {
  cardId: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
  state: string;
};

type DraftHit = { id: string; title: string; status: IntellEngineDraftStatus };

type Row = { key: string; href: string; label: string; sub: string | null; group: "grant" | "draft" };

export function PortalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [grants, setGrants] = useState<GrantHit[]>([]);
  const [drafts, setDrafts] = useState<DraftHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const open = focused && q.length >= MIN_QUERY;

  function reset() {
    setQuery("");
    setGrants([]);
    setDrafts([]);
    setActive(0);
  }

  // Click outside closes AND clears — without the clear, refocusing would show the
  // previous query's results as if they were current.
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

  // The abort matters more than the debounce: without it a slow early request can land
  // after a fast later one and overwrite good results with stale ones.
  useEffect(() => {
    if (q.length < MIN_QUERY) {
      setGrants([]);
      setDrafts([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/portal/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json().catch(() => ({}));
        setGrants(data.grants ?? []);
        setDrafts(data.drafts ?? []);
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
      ...grants.map((g) => ({
        key: `g:${g.cardId}`,
        href: `/portal/grants/${g.cardId}`,
        label: g.title || "Untitled opportunity",
        sub: [g.funder, g.state].filter(Boolean).join(" · ") || null,
        group: "grant" as const,
      })),
      ...drafts.map((d) => ({
        key: `d:${d.id}`,
        href: `/intellengine/${d.id}`,
        label: d.title,
        sub: STATUS_LABEL[d.status] ?? null,
        group: "draft" as const,
      })),
    ],
    [grants, drafts],
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

  let firstDraft = -1;
  rows.forEach((r, i) => {
    if (firstDraft === -1 && r.group === "draft") firstDraft = i;
  });

  return (
    <div ref={wrapRef} className="relative hidden md:block">
      <div
        className={cn(
          "flex h-8 w-[230px] items-center gap-2 rounded-sharp bg-white/[0.08] px-2.5 transition-colors duration-[120ms] ease-out lg:w-[270px]",
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
          placeholder="Search your grants"
          aria-label="Search your grants and proposals"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/[0.45]"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/[0.45]" aria-hidden="true" />}
      </div>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[360px] overflow-hidden rounded-md bg-white shadow-overlay">
          <div className="max-h-[60vh] overflow-y-auto">
            {rows.length === 0 && !loading ? (
              <div className="px-4 py-4 text-center">
                <p className="text-[13px] font-medium text-brand-navy">No matches for “{q}”</p>
                {/* Says what it looked at, so an empty result is not read as "this grant
                    does not exist" when it may simply not be one of theirs. */}
                <p className="mt-1 text-[11.5px] text-ink-subtle">
                  Searched grants matched to you and your proposal titles.
                </p>
              </div>
            ) : (
              <ul className="py-1">
                {rows.map((r, i) => (
                  <li key={r.key}>
                    {(i === 0 || i === firstDraft) && (
                      <p className="px-4 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.11em] text-ink-subtle">
                        {r.group === "grant" ? "Your grants" : "Your proposals"}
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
                      {r.group === "grant" ? (
                        <FileSearch className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
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
