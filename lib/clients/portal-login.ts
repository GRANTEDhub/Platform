import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";

// Shared helpers for provisioning a client's PORTAL login. Used by the staff
// "Add login" action (clients/[id]/portal-actions.ts) and the new "Invite client"
// onboarding flow (clients/invite-actions.ts), so the auth-provisioning logic
// lives in exactly one place and can't drift.

type AdminClient = ReturnType<typeof createServiceClient>;

// Provision (or find) the Supabase auth login for a client member, by email. The
// client_members row MUST already exist first, so the on_auth_user_created
// trigger links it to this user instead of staff-profiling them (see 0055).
// Returns the resolved auth user id, or null if it couldn't be resolved. Throws
// only on a genuine createUser failure -- callers roll back their own writes.
export async function resolveOrCreateAuthUser(admin: AdminClient, email: string): Promise<string | null> {
  // email_confirm so OTP / recovery sign-in works immediately; no password is set
  // here -- the client sets one on the set-password page via their setup link.
  const { data: created, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created?.user) return created.user.id;
  if (error && /already|registered|exists/i.test(error.message)) {
    // Existing account (re-invite, or a member of another org): find + link it.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    return list?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
  }
  throw new Error(`Could not create the login: ${error?.message ?? "unknown error"}`);
}

// Build a one-time set-up link for an already-provisioned client login. We use a
// Supabase 'recovery' link (it verifies + logs the user in, and permits setting a
// password) but email it ourselves via Resend -- so we take just the hashed_token
// and point it at our own /auth/confirm route, which verifies it, sets the
// session, and redirects to the set-password page. Mirrors how the login
// magic-link flow reaches /auth/confirm.
export async function generateClientSetupLink(admin: AdminClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  const token = data?.properties?.hashed_token;
  if (error || !token) throw new Error(`Could not generate a setup link: ${error?.message ?? "no token"}`);
  return `${appBaseUrl()}/auth/confirm?token_hash=${encodeURIComponent(token)}&type=recovery&next=${encodeURIComponent("/set-password")}`;
}
