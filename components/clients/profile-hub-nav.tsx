"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { DISCARD_PROFILE_EDITS_CONFIRM, useFormDirty } from "./form-exit-guard";

// The Profile-management hub's tab bar: Profile · Documents · Context pack.
//
// Three destinations that were three top-right buttons on the client record. They are one
// job -- "what does the platform hold about this org, and is it right" -- reached three
// ways: by typing (Profile), by handing it a document (Documents), or by reading what a
// machine will be told (Context pack). As buttons they read as three unrelated features and
// crowded out the two controls that ARE top-level (Profile management, Refresh matches).
//
// ── TABS OVER ROUTES, NOT PANES IN ONE PAGE ──
//
// The obvious build is `extras` on the edit page: ClientForm already renders extra panes in
// its section bar, which is how API data and Client admin stopped being routes. It is the
// wrong shape here, and the two pages say why in their own headers: the context pack runs
// seven queries and renders a few thousand words, and Documents runs three plus
// buildProposalSet over every stored document. Extras are server-rendered by the edit page
// and mounted-then-hidden (never lazily), so folding these in would charge every visit to
// Profile for both -- exactly the cost each route was split out to avoid.
//
// As routes, each tab still pays only for itself, and the consolidation is navigation: one
// persistent bar, no Back-button detour through the dashboard to get between them.
//
// ── AND THEREFORE THIS BAR GUARDS THE FORM ──
//
// Making them one click apart creates an exit that did not exist: you could not previously
// reach Documents from a half-edited profile without going Back, which FormExitGuard
// confirms. A client-side <Link> fires no beforeunload, so the tab that leaves a dirty
// Profile has to ask the same question, in the same words -- hence `guardProfileForm`.

export type ProfileHubTab = "profile" | "documents" | "context-pack";

const TABS: { key: ProfileHubTab; label: string; segment: string }[] = [
  { key: "profile", label: "Profile", segment: "edit" },
  { key: "documents", label: "Documents", segment: "documents" },
  { key: "context-pack", label: "Context pack", segment: "context-pack" },
];

export function ProfileHubNav({
  clientId,
  active,
  // Profile tab only: watch the edit form and confirm before a tab click discards it.
  guardProfileForm = false,
}: {
  clientId: string;
  active: ProfileHubTab;
  guardProfileForm?: boolean;
}) {
  const router = useRouter();
  const { dirty } = useFormDirty(guardProfileForm ? "form" : null);

  // Real <Link>s (prefetch, middle-click, copy-link all keep working) with the confirm
  // layered on top: preventDefault only when the answer is "no".
  function onNavigate(e: React.MouseEvent, href: string) {
    if (!dirty) return;
    e.preventDefault();
    if (window.confirm(DISCARD_PROFILE_EDITS_CONFIRM)) router.push(href);
  }

  return (
    <nav aria-label="Profile management" className="flex flex-wrap items-center gap-1.5">
      {TABS.map((t) => {
        const href = `/clients/${clientId}/${t.segment}`;
        const isActive = t.key === active;
        // The pack is an INSPECTION view now, and its weight in the bar says so: last,
        // pushed to the far end, quieter than the two everyday tabs. GrantBot consumes the
        // pack on its own; a human opens it to check what GrantBot was told.
        const buried = t.key === "context-pack";
        return (
          <Link
            key={t.key}
            href={href}
            onClick={(e) => onNavigate(e, href)}
            aria-current={isActive ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              buried ? "ml-auto" : ""
            } ${
              isActive
                ? "bg-brand-navy text-white"
                : buried
                  ? "text-brand-navy/45 hover:bg-brand-navy/[0.06] hover:text-brand-navy/70"
                  : "bg-brand-navy/[0.06] text-muted-foreground hover:bg-brand-navy/[0.12] hover:text-brand-navy"
            }`}
          >
            {t.label}
            {buried && (
              <span
                className={`ml-1.5 text-[10px] uppercase tracking-wide ${
                  isActive ? "text-white/60" : "text-brand-navy/35"
                }`}
              >
                inspect
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
