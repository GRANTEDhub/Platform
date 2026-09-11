// The GrantBot Switcher — the universal bottom-right bubble on every internal page. This module is
// the pure, client-safe core: the flag reader and the visibility rule. No server imports, so both
// the server layout (which reads the flag) and the client Switcher component (which reads the
// visibility rule on every navigation) import from here.
//
// S1 scope: the Switcher hosts the FIRM bot only. The firm bot is admin-only, and on a client
// RECORD page the existing per-client launcher owns the corner (that bot needs the client's name,
// which only the record page has). So S1 stands down on client record pages and shows for admins
// everywhere else. S2 widens this — a roster picker gives the Switcher every client's identity, it
// hosts any client bot from anywhere, and it subsumes the launcher.

// Byte-identical OFF: not the literal "true" ⟹ false, so the layout never mounts the component and
// the tree is exactly today's. Vercel binds env at build, so flipping this is a redeploy, not a live
// toggle (the standing GrantBot-flag caveat).
export function switcherEnabled(): boolean {
  return process.env.GRANTBOT_SWITCHER_ENABLED === "true";
}

// The per-client launcher renders on ONE route only — the client dashboard at /clients/<id>
// (app/(app)/clients/[id]/page.tsx, the only <GrantBotLauncher> mount). It is NOT on that client's
// SUB-routes (/clients/<id>/roadmap, …/grants, …/grantbot, …/edit) and NOT on the /clients/new or
// /clients/invite forms — none of those mount the launcher. So the firm Switcher must stand down on
// EXACTLY the dashboard route and show everywhere else; matching the whole /clients/<id>/* subtree
// (the first cut) left every client sub-page with NO bot at all (Codex #544). Matches one segment
// after /clients/ with nothing after it (optional trailing slash), excluding the `new`/`invite`
// route segments, which are real routes rather than client ids. /clients (the LIST) is false too.
export function isClientDashboardPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const m = /^\/clients\/([^/]+)\/?$/.exec(pathname);
  if (!m) return false;
  return m[1] !== "new" && m[1] !== "invite";
}

// The standalone firm page /grantbot IS the full firm chat, so a corner firm bubble there is
// redundant and would overlay the full page (Codex #544). Exclude it (and any future subpath).
export function isFirmFullPagePath(pathname: string | null | undefined): boolean {
  return pathname === "/grantbot" || (pathname?.startsWith("/grantbot/") ?? false);
}

// Whether the firm Switcher renders on the current path. S1: admin AND not on the client dashboard
// (where the launcher owns the corner) AND not on the firm full page. Re-evaluated on every
// navigation, so there is never a double bubble with the per-client launcher. Belt-and-suspenders:
// even for a non-admin the firm routes are requireAdmin and 404, so a leaked bubble could not send —
// this just hides it.
export function firmSwitcherVisible(pathname: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin && !isClientDashboardPath(pathname) && !isFirmFullPagePath(pathname);
}
