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
