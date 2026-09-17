// The GrantBot Switcher — the universal bottom-right bubble on every internal page. This module is
// the pure, client-safe core: the flag reader, the path helpers, and the visibility rule. No server
// imports, so both the server layout (which reads the flag) and the client Switcher component (which
// reads the helpers on every navigation) import from here.
//
// S2 scope: the Switcher hosts the FIRM bot AND any CLIENT bot, chosen from a roster picker. It now
// OWNS the corner everywhere (including the client dashboard) and SUBSUMES the per-client launcher —
// the dashboard mounts the launcher only while the Switcher flag is OFF (byte-identical revert). The
// picker's roster read finally gives the Switcher every client's name, which is why S1 could host
// firm only (the layout knows the path, not the name).

// Byte-identical OFF: not the literal "true" ⟹ false, so the layout never mounts the component and
// the tree is exactly today's. Vercel binds env at build, so flipping this is a redeploy, not a live
// toggle (the standing GrantBot-flag caveat).
export function switcherEnabled(): boolean {
  return process.env.GRANTBOT_SWITCHER_ENABLED === "true";
}

// The client-dashboard id for a path, or null. A dashboard is EXACTLY /clients/<id> (optional
// trailing slash) — NOT its sub-routes (/clients/<id>/roadmap, …/grantbot) and NOT the
// /clients/new · /clients/invite forms (real routes, not client ids). Used two ways: the launcher
// mounts on exactly this route (S1), and the Switcher DEFAULTS its target to this client when you
// land on a dashboard (S2, "the bubble here is this client's bot" — matching the launcher).
export function clientDashboardId(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const m = /^\/clients\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  return m[1] === "new" || m[1] === "invite" ? null : m[1];
}

// Kept from S1 for the tests + readability: whether a path is a client dashboard.
export function isClientDashboardPath(pathname: string | null | undefined): boolean {
  return clientDashboardId(pathname) !== null;
}

// A FULL GrantBot page — the firm one (/grantbot) or a client one (/clients/<id>/grantbot) — already
// IS the full chat for that target, so a corner bubble there would duplicate it (the S1 /grantbot
// finding, now generalized to the client full page too, which carries its own "Collapse to corner").
// The Switcher hides on these.
export function isFullGrantbotPage(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/grantbot" || pathname.startsWith("/grantbot/")) return true;
  return /^\/clients\/[^/]+\/grantbot(?:\/|$)/.test(pathname);
}

// Whether the Switcher renders on the current path. S2: it shows on EVERY internal page (it now
// hosts client bots, so contractors get it too, not just admins) EXCEPT a full GrantBot page. The
// role only decides what the PICKER offers (Firm is admin+firm-flag only), not whether the bubble
// shows. Re-evaluated on every navigation. Belt-and-suspenders: the firm/turn routes gate
// server-side regardless, so a shown bubble can never act beyond the actor's access.
export function switcherVisible(pathname: string | null | undefined): boolean {
  return !isFullGrantbotPage(pathname);
}

// A roster row for the picker (what GET /api/grantbot/roster returns per client).
export type RosterClient = { id: string; name: string };

// A raw client_overview row as the roster route selects it (before filtering to the picker shape).
export type RosterRow = { id: string | null; name: string | null; pipeline_stage: string | null };

// The roster fetch URL. When the Switcher is ON a client dashboard, it passes that client's id as
// `include` so the endpoint keeps it in the roster EVEN IF it is archived/rejected — otherwise the
// layout-mounted Switcher has no name source for a filtered client and would mis-host its dashboard
// bubble (the S2 archived-dashboard regression). Off a dashboard, the plain roster.
export function rosterUrl(dashId: string | null | undefined): string {
  return dashId ? `/api/grantbot/roster?include=${encodeURIComponent(dashId)}` : "/api/grantbot/roster";
}

// Pure filter from raw client_overview rows to the picker roster: keep rows with a real id + name,
// drop archived/rejected (dead relationships, matching the Portfolio list) — EXCEPT always keep
// `includeId` when present (the client whose dashboard the staffer is currently on, so the Switcher
// can resolve its name and host its bot even when it is archived/rejected). `rows` is already
// RLS-scoped by the caller, so `includeId` can only ever re-admit a client the staffer may see.
export function pickRosterClients(rows: RosterRow[], includeId?: string | null): RosterClient[] {
  return rows
    .filter(
      (c): c is { id: string; name: string; pipeline_stage: string | null } =>
        !!c && typeof c.id === "string" && typeof c.name === "string" && c.name.length > 0,
    )
    .filter(
      (c) =>
        (c.pipeline_stage !== "archived" && c.pipeline_stage !== "rejected") ||
        (includeId != null && c.id === includeId),
    )
    .map((c) => ({ id: c.id, name: c.name }));
}

// What the Switcher is pointed at. A client target always carries its resolved name, because the
// hosted GrantBotChat requires it — the component holds an unresolved dashboard id separately and
// only forms a client target once the roster resolves the name.
export type SwitcherTarget = { kind: "firm" } | { kind: "client"; id: string; name: string };

// localStorage key for the last manually-picked target, so the Switcher reopens on it off-dashboard.
export const SWITCHER_TARGET_KEY = "grantbot:switcher-target";

// ── S3: the unified "Recent" thread rail ──
// One row in the Switcher's Recent view: a past GrantBot conversation across ANY scope the staffer can
// see (a firm thread, or a client thread for a client in their RLS-scoped roster). Clicking one jumps
// straight into that conversation. `GET /api/grantbot/recent` returns these, most-recent first.
export type RecentThread = {
  id: string;
  scope: "firm" | "client";
  clientId: string | null; // set for a client thread, null for firm
  clientName: string | null; // resolved name for a client thread, null for firm
  title: string | null;
  lastMessageAt: string; // ISO — sortable as a plain string
};

// Merge the firm + client thread lists into one recency-ordered list, capped. Pure so the recent route
// (and its test) share one definition of "most recent across scopes". lastMessageAt is an ISO string,
// so a lexical compare is a chronological compare; a missing/empty value sorts last.
export function mergeRecentThreads(
  firm: RecentThread[],
  client: RecentThread[],
  limit: number,
): RecentThread[] {
  return [...firm, ...client]
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0))
    .slice(0, Math.max(0, limit));
}

// ── In-place open (Ask GrantBot from a grant card) ──
// The Switcher is mounted on EVERY internal page, so a page that wants to open it — the "Ask GrantBot"
// button on a grant card's IntellEngine tile — does NOT need to navigate to the dashboard to trigger the
// `?grantbot=` deep-link (that dashboard bounce is the bug). It dispatches this window event instead, and
// the mounted Switcher opens the corner IN PLACE on the given client at a new blank thread (the grant
// anchor is already stashed under askContextKey, consumed by the corner chat's mount). A CustomEvent on
// `window` is the seam because the button and the Switcher are unrelated subtrees (the Switcher lives in
// the app layout, the button deep in a page), so there is no prop path between them. Fires only when the
// Switcher flag is on — the button falls back to the dashboard deep-link when it is off (launcher path).
export const GRANTBOT_OPEN_EVENT = "grantbot:open-in-place";

// The event detail: which client's bot to open, AND its display name. The name matters: it lets the
// listener set a FULLY-RESOLVED target ({kind:"client", id, name}) so it does not have to resolve the name
// from the roster. The roster fetch on a grant sub-route carries no `?include=` (dashId is null there), so
// a client missing from the cached roster — archived/rejected, or created after the session's first fetch
// — would never resolve and the Ask would silently fall back to Firm/another client, dropping the anchored
// question. The grant card already knows the client's name, so handing it over sidesteps that hole. A new
// blank thread every time (Ask GrantBot always starts a fresh anchored conversation), so no conversation
// id — the grant anchor rides askContextKey, not this.
export type OpenGrantBotDetail = { clientId: string; clientName: string };

// Dispatch the in-place open. Window-guarded (SSR no-op) and typed so the button and the listener share one
// event shape. Safe to call when no Switcher is listening (a no-op DOM event) — but the button only calls
// this when the Switcher flag is on, so there is always a listener in that path.
export function dispatchOpenGrantBot(clientId: string, clientName: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenGrantBotDetail>(GRANTBOT_OPEN_EVENT, { detail: { clientId, clientName } }),
  );
}

// ── In-place open of the FIRM bot (Ask GrantBot from the prospecting page) ──
// The firm sibling of GRANTBOT_OPEN_EVENT. The "Ask GrantBot" button on /intel/[id] dispatches this so
// the mounted Switcher opens the FIRM bot IN PLACE at a NEW blank thread (the staffer stays on the page).
// NO detail: the firm target needs no id/name to resolve ("firm" is the whole target), and the grant
// anchor rides the firm ask-context stash (firm-ask-intent.ts), consumed by the firm chat on mount — so,
// like the per-client event, this only opens the panel + sets the target; the grant never crosses on the
// event. Fires only when the Switcher flag is on (the button falls back to navigating to /grantbot when
// it is off). Dormant unless the button dispatches, so no existing Switcher behavior changes.
export const GRANTBOT_OPEN_FIRM_EVENT = "grantbot:open-firm-in-place";

export function dispatchOpenFirmGrantBot(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GRANTBOT_OPEN_FIRM_EVENT));
}

// Whether a dashboard-navigation effect must FORCE the corner chat body to remount (a bodyNonce bump).
// The body is keyed by the client id, and its "open on this conversation" props + the composer SEED
// (GrantBotChat's mount-only takeDraft) are consumed ONLY on mount. So a "?grantbot=" deep-link — the
// Ask-GrantBot seed, or a Collapse-to-corner — whose target is the client the corner is ALREADY pointed
// at (`sameTarget`) leaves the id key unchanged: the body never remounts, so the pendingInitial + the
// stashed seed are never consumed and the seed opens BLANK (the deferred Ask-GrantBot follow-up). A
// forced remount on exactly that case consumes them. When the deep-link switches to a DIFFERENT client
// (`!sameTarget`) the id key already changes, so the body remounts on its own and no bump is needed; a
// navigation with no deep-link (`!hasDeepLink`) has no seed/conversation to open, so it must NOT remount
// (that would flash a spinner + refetch the transcript for nothing). Pure so the truth table is locked.
export function deepLinkNeedsRemount(hasDeepLink: boolean, sameTarget: boolean): boolean {
  return hasDeepLink && sameTarget;
}
