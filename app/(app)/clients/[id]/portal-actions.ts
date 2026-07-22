"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";

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

  // Provision the login (open signup is off → we create it). Silent: no email is
  // sent; staff tell the client to sign in at the login page (the magic link works
  // because the account now exists). email_confirm so OTP sign-in works immediately.
  let userId: string | null = null;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created?.user) {
    userId = created.user.id;
  } else if (createErr && /already|registered|exists/i.test(createErr.message)) {
    // Existing account (re-add, or a member of another org): find + link it.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = list?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
  } else {
    // Real failure → roll back the membership so nothing is left half-provisioned.
    await admin.from("client_members").delete().eq("client_id", clientId).eq("email", email);
    throw new Error(`Could not create the login: ${createErr?.message ?? "unknown error"}`);
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
