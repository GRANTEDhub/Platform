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

// A client RECORD path is /clients/<id> and anything under it (/clients/<id>/grantbot, …). The
// portfolio LIST at /clients is NOT a record — no id segment — so the firm Switcher shows there. The
// pattern requires at least one non-slash segment after /clients/, so /clients and /clients/ are
// both false.
export function isClientRecordPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /^\/clients\/[^/]+/.test(pathname);
}

// Whether the firm Switcher renders its bubble on the current path. S1: admin AND not on a client
// record page (where the launcher owns the corner). Re-evaluated on every navigation, so there is
// never a double bubble with the per-client launcher. Belt-and-suspenders: even for a non-admin the
// firm routes are requireAdmin and 404, so a leaked bubble could not send — this just hides it.
export function firmSwitcherVisible(pathname: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin && !isClientRecordPath(pathname);
}
