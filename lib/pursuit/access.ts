// Client access to the Pursuit (IntellEngine) surfaces — TWO INDEPENDENT switches.
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
// TWO FLAGS, because "can a client USE it" and "does a client SEE a teaser for it" are
// different questions, and the soft-launch needs a state the single flag could not express:
// visible-but-blocked. They are INDEPENDENT -- neither derives from the other:
//
//   PURSUIT_CLIENT_ACCESS_ENABLED   -> pursuitClientAccessEnabled(): REAL client route/API access.
//                                      Gates requirePursuitVisible() / pursuitApiDenied() and every
//                                      LIVE link/option. This is the reachability switch.
//   INTELLENGINE_CLIENT_COMING_SOON -> intellEngineComingSoon(): PRESENTATION only. Renders the
//                                      client-facing surfaces (portal nav tab, dashboard tile, Grant
//                                      Report pursue-chooser option) as a VISIBLE, unclickable
//                                      "COMING SOON" teaser. It changes NOTHING about what a client
//                                      can REACH -- a teased tile still 404s (requirePursuitVisible)
//                                      and the API still refuses (pursuitApiDenied). Safe by
//                                      construction: it only decides what a client SEES, never what
//                                      they can touch.
//
// The four combinations, for CLIENTS (staff always see the live feature -- see below):
//   access off · coming-soon off  -> hidden entirely (the original gated state)
//   access off · coming-soon ON   -> visible-but-blocked teaser   <-- SOFT-LAUNCH (UAMS/NWACC)
//   access ON  · coming-soon off  -> live
//   access ON  · coming-soon ON   -> live WINS. Every surface checks access first, so a stray teaser
//                                    flag can never downgrade a genuinely-live feature. A nonsensical
//                                    config, but it fails safe toward "usable," not toward "blocked."
//
// LAUNCH SETTINGS: PURSUIT_CLIENT_ACCESS_ENABLED unset/false (clients blocked) + INTELLENGINE_CLIENT_
// COMING_SOON=true (clients teased). Staff are live the whole time regardless (they never depend on
// the access flag). When IntellEngine is genuinely ready for clients, set PURSUIT_CLIENT_ACCESS_
// ENABLED=true and drop the coming-soon flag.
//
// STAFF ARE UNAFFECTED by BOTH flags, deliberately. Staff drive the same wizard on a client's behalf
// from the console and rely on these routes for preview; the problem is what a CLIENT is promised, not
// that the screens exist. requirePursuitVisible()/pursuitApiDenied() return early for any staff
// profile (getProfile), and the coming-soon teaser is only ever passed into client render paths -- so
// neither flag can touch staff. A client being BLOCKED therefore does NOT require the access flag to
// be off "for staff": it is off for clients and staff pass anyway.
//
// BOTH default OFF and each takes the literal string "true" to enable -- same shape as canSendEmail()'s
// EMAIL_SENDING_ENABLED check (lib/email/guard.ts). An unset, empty, misspelled, or "1" value reads as
// off, because the failure that matters is accidentally exposing an unfinished client-facing surface,
// not accidentally hiding a finished one.

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfile } from "@/lib/auth";

export function pursuitClientAccessEnabled(): boolean {
  return process.env.PURSUIT_CLIENT_ACCESS_ENABLED === "true";
}

/**
 * The client-visibility switch for the "COMING SOON" soft-launch teaser -- INDEPENDENT of access.
 *
 * When true, the client-facing IntellEngine surfaces (portal nav tab, dashboard tile, Grant Report
 * pursue-chooser option) render VISIBLE but unclickable, with a "COMING SOON" label. It is NOT the
 * negation of pursuitClientAccessEnabled(): the two are separate env vars, so you can tease WITHOUT
 * granting access (the soft-launch state), and leaving both off hides IntellEngine from clients
 * entirely. Every surface checks access FIRST, so when access is on this teaser is ignored (live
 * wins) -- see the truth table at the top of this file.
 *
 * CLIENT SURFACES ONLY. Staff never see the teaser; the console renders IntellEngine live regardless
 * of both flags (staff reach it per-client at /clients/:id/intellengine).
 */
export function intellEngineComingSoon(): boolean {
  return process.env.INTELLENGINE_CLIENT_COMING_SOON === "true";
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
