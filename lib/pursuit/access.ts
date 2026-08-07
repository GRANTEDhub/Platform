// Client access to the Pursuit (IntellEngine) surfaces — one kill switch.
//
// WHY THIS EXISTS. The Pursuit screens are built but not finished: the scope editor
// holds its state locally and never POSTs, and the compliance step discards the file it
// is handed and turns the row green anyway (app/intellengine/scope/scope-client.tsx,
// app/intellengine/compliance/compliance-client.tsx:164). Both surfaces assert success
// they cannot deliver, and they were reachable by clients in production -- a permanent
// nav tab, a dashboard tile, portal search, and the Grant Report's pursuit chooser all
// led there. A client could scope a project, upload their audit, watch the row confirm,
// navigate away, and lose all of it. Losing the work is bad; being told it was saved is
// worse. See docs/matching-pursuit-model.md §7.
//
// DECISION: gated off entirely for clients -- invisible and unreachable, not
// show-but-disabled and not a placeholder. A disabled control still advertises a feature
// we cannot honour yet, and the "Soon" nav links were already rejected once for that
// reason. When persistence lands and the silent-drop behaviour is fixed, the flag flips.
//
// STAFF ARE UNAFFECTED, deliberately. Staff drive the same wizard on a client's behalf
// from the console and rely on these routes for preview; the problem is what a CLIENT is
// promised, not that the screens exist. requireClientOrAdmin() already returns early for
// any staff profile, so the gate here only ever narrows the client branch.
//
// OFF BY DEFAULT, and it takes the literal string "true" to enable -- same shape as
// canSendEmail()'s EMAIL_SENDING_ENABLED check (lib/email/guard.ts). An unset, empty,
// misspelled, or "1" value all read as off, because the failure that matters is
// accidentally exposing an unfinished client-facing surface, not accidentally hiding a
// finished one.

import { notFound } from "next/navigation";
import { getProfile } from "@/lib/auth";

export function pursuitClientAccessEnabled(): boolean {
  return process.env.PURSUIT_CLIENT_ACCESS_ENABLED === "true";
}

/**
 * Page guard for the /intellengine route tree. Staff always pass. A client passes only
 * while the flag is on; otherwise the route 404s.
 *
 * NOT a redirect. A redirect to /portal would tell a client the route exists and simply
 * is not theirs, which invites a support question about a feature we are deliberately
 * hiding. notFound() renders the same thing an unknown URL renders.
 *
 * Call this AFTER the existing auth guard on each page, never instead of it: the auth
 * check is what turns an unauthenticated request into /login, and it must keep happening
 * first so that flipping this flag can never widen access.
 */
export async function requirePursuitVisible(): Promise<void> {
  if (pursuitClientAccessEnabled()) return;
  if (await getProfile()) return; // any staff (admin or contractor)
  notFound();
}

/**
 * API equivalent of requirePursuitVisible: true when the caller must be refused.
 *
 * The route handlers are their own entry point -- hiding a button does not close the
 * endpoint behind it, and the pursuit chooser POSTs to /api/intellengine/drafts to mint
 * a draft before it navigates. Gating the UI alone would leave a client able to create
 * draft rows for a feature they cannot see.
 */
export async function pursuitApiDenied(): Promise<boolean> {
  if (pursuitClientAccessEnabled()) return false;
  return !(await getProfile());
}
