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
// only fires in production; the setup link is one-time, so it naturally fires once per client.
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

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("client_members")
      .select("email, client_id, clients(name)")
      .eq("user_id", user.id)
      .maybeSingle<{ email: string | null; client_id: string; clients: { name: string } | null }>();
    if (!member?.client_id) return; // not a client member (e.g. staff) -> nothing to notify about

    await sendSignupNotificationEmail({
      clientId: member.client_id,
      clientName: member.clients?.name ?? "A client",
      contactEmail: member.email ?? user.email ?? null,
    });
  } catch (e) {
    // Never throw: this must not affect the client's account setup or navigation.
    console.error("[signup-notify] failed:", e instanceof Error ? e.message : e);
  }
}
