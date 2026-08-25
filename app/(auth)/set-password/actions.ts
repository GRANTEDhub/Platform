"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendEmail } from "@/lib/email/guard";
import { sendSignupNotificationEmail } from "@/lib/email/send";

// Fired by the set-password page the moment an invited client finishes setup (sets their password
// via supabase.auth.updateUser in the browser). This is the "account created" event staff want to
// know about -- it tells us WHO just completed setup so their match run can be triggered.
//
// Why here and not a Supabase auth hook: the auth user is CREATED at invite time (portal-actions
// resolveOrCreateAuthUser), so a user-created hook fires when staff add the login, not when the
// client finishes. Setting the password is an auth.users UPDATE with a live session, so this
// session-scoped server action is the clean seam at the actual completion moment.
//
// FAIL-SAFE + ADDITIVE: the whole body is wrapped so a notify failure can never surface to the
// client or block their redirect (the page calls it fire-and-forget). Gated on canSendEmail() so it
// only fires in production, and on FIRST setup only (see the profile_confirmed_at check) so a resent
// setup link / password reset for an already-onboarded client does NOT re-notify.
type ClientEmbed = { name: string | null; profile_confirmed_at: string | null };

export async function notifyAccountSetupComplete(): Promise<void> {
  try {
    if (!canSendEmail().ok) return; // prod + EMAIL_SENDING_ENABLED + key only; previews never notify

    // The set-password page runs on a live session (the recovery link set it), so getUser resolves
    // the client who just finished. Read under the request session, then look up their org via the
    // service role (client_members is staff/self read-only; the join to clients needs service).
    const {
      data: { user },
    } = await createClient().auth.getUser();
    if (!user) return;

    // NOT .maybeSingle(): user_id is a NON-unique index (0055) -- one auth user can be a member of
    // several client orgs (a shared consultant email, linked onto each via resolveOrCreateAuthUser).
    // maybeSingle() errors (PGRST116) on 2+ rows and returns null, which would SILENTLY drop the
    // notification. Iterate instead and notify per still-onboarding org.
    const admin = createServiceClient();
    const { data: members } = await admin
      .from("client_members")
      .select("id, email, client_id, clients(name, profile_confirmed_at)")
      .eq("user_id", user.id)
      .returns<
        {
          id: string;
          email: string | null;
          client_id: string;
          // PostgREST can return an embedded to-one relation as an object OR a 1-element array,
          // depending on how the relationship is inferred -- handle both so the org name never drops.
          clients: ClientEmbed | ClientEmbed[] | null;
        }[]
      >();

    for (const member of members ?? []) {
      if (!member.client_id) continue;
      const client = Array.isArray(member.clients) ? member.clients[0] : member.clients;

      // FIRST-SETUP ONLY. profile_confirmed_at is ORG-level (set once any member confirms the profile
      // at /welcome), so this skips an org this user already onboarded -- a resent setup link /
      // password reset, or their OTHER org. Known limit: for a multi-seat org, if two members set
      // their passwords BEFORE either confirms the profile, each fires a notice; the per-member
      // wording (below) keeps that accurate ("<email> set up their account for <org>") rather than
      // reading as a duplicate org onboarding.
      if (client?.profile_confirmed_at) continue;

      // EXACTLY-ONCE CLAIM, and it is what makes this replay-proof. notifyAccountSetupComplete
      // compiles to a POST endpoint an authenticated invited client can call directly, so the
      // submit-guards on the page (a same-tick ref, the overlay) only stop the honest double-tap
      // -- they can't stop a scripted replay. profile_confirmed_at is org-level and doesn't flip
      // until the client confirms at /welcome, so without this a client could POST this action in
      // a loop between setup and confirm and flood shannon@ (and burn Resend). The claim is a
      // conditional UPDATE: stamp setup_notified_at only where it IS NULL, and the row count tells
      // us whether THIS call won the race. Lost/repeat calls read zero rows and skip the send.
      //
      // The claim is a RESERVATION, not a record of a sent email -- see the send-failure rollback
      // below. On the SUCCESSFUL-send path the stamp sticks and every replay is a no-op, so each
      // member is notified at most once no matter how many times the action is invoked.
      const { data: claimed, error: claimError } = await admin
        .from("client_members")
        .update({ setup_notified_at: new Date().toISOString() })
        .eq("id", member.id)
        .is("setup_notified_at", null)
        .select("id");
      // supabase-js RETURNS query errors, it does not throw them (no .throwOnError()), so the outer
      // try/catch can't see a failed claim -- and a null `claimed` from an ERROR is otherwise
      // indistinguishable from a null from a LOST race. Log it (the send path below logs its
      // failures; a swallowed claim failure must leave the same trail) and skip: on a claim error we
      // don't know whether the row got stamped, so sending anyway risks a double-notify.
      if (claimError) {
        console.error(`[signup-notify] claim failed for client ${member.client_id}:`, claimError.message);
        continue;
      }
      if (!claimed || claimed.length === 0) continue;

      // Per-org try/catch: one org's Resend failure must not abort the loop and skip later orgs.
      try {
        await sendSignupNotificationEmail({
          clientId: member.client_id,
          clientName: client?.name ?? "A client",
          contactEmail: member.email ?? user.email ?? null,
        });
      } catch (e) {
        // RELEASE THE CLAIM so a later attempt (repeat visit / retry) can re-notify. Stamping before
        // the send is what closes the flood -- a concurrent replay loses the race and skips -- but a
        // send that then FAILS must not leave the row permanently claimed, which would silently drop
        // the one notification this whole feature exists to deliver. Rolling back only re-opens
        // replays when sends are FAILING, and a failing send produces no inbox flood by definition;
        // the successful-send path keeps its claim and stays a no-op on replay. A failed rollback is
        // logged (can't be helped further here) but is the rare case: the row simply stays claimed.
        const { error: releaseError } = await admin
          .from("client_members")
          .update({ setup_notified_at: null })
          .eq("id", member.id);
        console.error(
          `[signup-notify] send failed for client ${member.client_id}:`,
          e instanceof Error ? e.message : e,
          releaseError ? `(claim release also failed: ${releaseError.message})` : "",
        );
      }
    }
  } catch (e) {
    // Never throw: this must not affect the client's account setup or navigation.
    console.error("[signup-notify] failed:", e instanceof Error ? e.message : e);
  }
}
