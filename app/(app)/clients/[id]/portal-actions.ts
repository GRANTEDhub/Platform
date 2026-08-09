"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { canSendOutreach } from "@/lib/email/guard";
import { sendClientInviteEmail } from "@/lib/email/send";
import { resolveOrCreateAuthUser, generateClientSetupLink } from "@/lib/clients/portal-login";

// Staff-only management of a client's PORTAL logins (the client_members "guest
// list") + seat limit. Every action is admin-gated and writes via the service
// client (consistent with the other client actions). Open signup is off, so the
// login itself is PROVISIONED here — the client can't self-register.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function inviteClientMember(formData: FormData) {
  await requireAdmin();
  const clientId = String(formData.get("client_id") || "");
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!clientId) throw new Error("Missing client.");
  if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");

  const admin = createServiceClient();

  // Seat gate: current members on this client vs its seat_limit.
  const { data: client } = await admin
    .from("clients")
    .select("seat_limit")
    .eq("id", clientId)
    .maybeSingle();
  const seatLimit = client?.seat_limit ?? 1;
  const { count: used } = await admin
    .from("client_members")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if ((used ?? 0) >= seatLimit) {
    throw new Error(
      `All ${seatLimit} seat${seatLimit === 1 ? "" : "s"} are in use — raise the seat limit to add more.`,
    );
  }

  // Already on this client's portal?
  const { data: existing } = await admin
    .from("client_members")
    .select("id")
    .eq("client_id", clientId)
    .eq("email", email)
    .maybeSingle();
  if (existing) throw new Error("That email is already on this client's portal.");

  // Membership first, so the on_auth_user_created trigger links (and does NOT
  // staff-profile) a newly created auth user.
  const { error: insErr } = await admin
    .from("client_members")
    .insert({ client_id: clientId, email, role: "member" });
  if (insErr) throw new Error(`Could not add member: ${insErr.message}`);

  // Provision the login (open signup is off → we create it). Shared with the
  // Invite-client onboarding flow via resolveOrCreateAuthUser. Adding is silent by
  // design — it does NOT email. Telling the client is a separate, explicit step:
  // "Send setup link" (sendClientSetupLink below), so staff choose when the client
  // hears from us rather than having a seat change fire mail on its own.
  let userId: string | null;
  try {
    userId = await resolveOrCreateAuthUser(admin, email);
  } catch (e) {
    // Real failure → roll back the membership so nothing is left half-provisioned.
    await admin.from("client_members").delete().eq("client_id", clientId).eq("email", email);
    throw e;
  }

  if (userId) {
    await admin
      .from("client_members")
      .update({ user_id: userId, activated_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("email", email);
  }

  revalidatePath(`/clients/${clientId}`);
}

// Email an EXISTING client's portal member a working setup link — the piece that was
// missing between "Add login" (provisions silently) and the client actually being able
// to get in. Onboarding a current roster used to mean provisioning the seat here and
// then hand-writing every client the login URL.
//
// Reuses the two halves the new-client Invite flow already runs on
// (generateClientSetupLink + sendClientInviteEmail), so an existing client gets the
// SAME "Welcome to GRANTED — set up your account" email, from one implementation.
//
// Unlike the invite flow — where a gated send must not roll back a created client — the
// send IS this whole action, so a blocked or failed send throws with the gate's reason
// verbatim and stamps nothing. Better a visible error than a row claiming it emailed.
export async function sendClientSetupLink(formData: FormData) {
  await requireAdmin();
  const clientId = String(formData.get("client_id") || "");
  const memberId = String(formData.get("member_id") || "");
  if (!clientId || !memberId) throw new Error("Missing member.");

  const admin = createServiceClient();

  // Scoped by client_id as well as id: a member_id belonging to another org must not
  // resolve here, even though staff are admin-gated.
  const { data: member } = await admin
    .from("client_members")
    .select("id, email")
    .eq("id", memberId)
    .eq("client_id", clientId)
    .maybeSingle<{ id: string; email: string }>();
  if (!member?.email) throw new Error("That portal member no longer exists.");

  const { data: client } = await admin
    .from("clients")
    .select("name, primary_contact_email, primary_contact_name")
    .eq("id", clientId)
    .maybeSingle<{ name: string; primary_contact_email: string | null; primary_contact_name: string | null }>();
  if (!client) throw new Error("That client no longer exists.");

  // Check the gate BEFORE minting a link, so a blocked send doesn't burn a one-time
  // token that then sits unused (the next real send would invalidate it anyway).
  const gate = canSendOutreach(member.email);
  if (!gate.ok) throw new Error(`Not sent — ${gate.reason}`);

  // The link needs an auth user to exist. Normally "Add login" already made one, but
  // this is idempotent (existing account → found and returned), so it also repairs a
  // membership whose provisioning failed at add time.
  const userId = await resolveOrCreateAuthUser(admin, member.email);
  if (userId) {
    // Link the account if it wasn't yet. activated_at is deliberately NOT touched —
    // that means "first successful login," which emailing a link is not.
    await admin.from("client_members").update({ user_id: userId }).eq("id", member.id);
  }

  // Greet by name only for the primary contact — a teammate on a second seat greeted
  // with the primary contact's name reads as a mail-merge failure.
  const isPrimaryContact =
    (client.primary_contact_email ?? "").trim().toLowerCase() === member.email.trim().toLowerCase();

  const url = await generateClientSetupLink(admin, member.email);
  await sendClientInviteEmail({
    to: member.email,
    contactName: isPrimaryContact ? client.primary_contact_name : null,
    orgName: client.name,
    url,
  });

  await admin
    .from("client_members")
    .update({ setup_link_sent_at: new Date().toISOString() })
    .eq("id", member.id);

  revalidatePath(`/clients/${clientId}/edit`);
}

export async function removeClientMember(formData: FormData) {
  await requireAdmin();
  const clientId = String(formData.get("client_id") || "");
  const memberId = String(formData.get("member_id") || "");
  if (!clientId || !memberId) throw new Error("Missing member.");

  // Deleting the membership revokes portal access immediately (requireClient needs
  // an ACTIVE membership). The auth account is left intact — harmless, and can be
  // fully removed from the Supabase dashboard if desired.
  const admin = createServiceClient();
  await admin.from("client_members").delete().eq("id", memberId).eq("client_id", clientId);
  revalidatePath(`/clients/${clientId}`);
}

export async function setClientSeats(formData: FormData) {
  await requireAdmin();
  const clientId = String(formData.get("client_id") || "");
  if (!clientId) throw new Error("Missing client.");
  const raw = Number(formData.get("seat_limit"));
  const seats = Math.max(1, Math.min(50, Math.floor(Number.isFinite(raw) ? raw : 1)));

  const admin = createServiceClient();
  await admin.from("clients").update({ seat_limit: seats }).eq("id", clientId);
  revalidatePath(`/clients/${clientId}`);
}
