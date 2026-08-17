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
// DECISION (original): gated off entirely for clients -- invisible and unreachable, not
// show-but-disabled and not a placeholder. When persistence lands and the silent-drop
// behaviour is fixed, the flag flips.
//
// AMENDED FOR THE SOFT-LAUNCH (UAMS/NWACC): while the flag is off, the client-facing
// surfaces now render a VISIBLE, unclickable "COMING SOON" gate instead of being omitted --
// see intellEngineComingSoon() below. This deliberately reverses the "invisible, not
// show-but-disabled" stance above, on the owner's call, because for the soft-launch we want
// these clients to see the feature is coming. It is safe precisely because the reachability
// guards here are unchanged: a visible-but-inert tile still 404s (requirePursuitVisible) and
// the API still refuses (pursuitApiDenied), so nothing about what a client can REACH changed
// -- only what they can SEE. The presentation gate is scoped to client render paths; staff
// render IntellEngine live everywhere, as before.
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
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfile } from "@/lib/auth";

export function pursuitClientAccessEnabled(): boolean {
  return process.env.PURSUIT_CLIENT_ACCESS_ENABLED === "true";
}

/**
 * The single client-visibility condition for the "COMING SOON" soft-launch gate.
 *
 * True while client access is gated off -- the client-facing IntellEngine surfaces (portal nav
 * tab, dashboard tile, Grant Report pursue-chooser option) then render VISIBLE but unclickable,
 * with a "COMING SOON" label, instead of being hidden. It is the exact negation of
 * pursuitClientAccessEnabled(), so there is ONE switch: set PURSUIT_CLIENT_ACCESS_ENABLED=true and
 * every surface goes live in the same flip that un-guards the routes (this returns false, the live
 * links/options render, the coming-soon treatment disappears).
 *
 * CLIENT SURFACES ONLY. Staff never call this; the console renders IntellEngine live regardless of
 * the flag (staff reach it per-client at /clients/:id/intellengine), so the gate cannot touch them.
 */
export function intellEngineComingSoon(): boolean {
  return !pursuitClientAccessEnabled();
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

// The STAFF-ONLY gate the IntellEngine LLM routes (requirements, draft-section, revise-section)
// share: authenticated + a profiles row (admin or contractor). A client portal member has none.
// 404 (not 403) so the route reads as ABSENT to a non-staff caller rather than advertising a
// forbidden endpoint. One definition rather than the same eight lines hand-copied per route -- a
// security policy that drifts silently is the failure mode this removes. Returns a discriminated
// result the route returns directly. (The export route intentionally uses resolveDocumentActor
// instead: it reaches admin-only org-level documents and needs the role, not just staff-ness.)
export type StaffGate = { ok: true; userId: string } | { ok: false; response: NextResponse };

export async function requireStaffUser(supabase: SupabaseClient): Promise<StaffGate> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return { ok: true, userId: user.id };
}
