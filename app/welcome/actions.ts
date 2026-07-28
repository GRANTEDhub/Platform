"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireClient } from "@/lib/auth";
import { canSendOutreach } from "@/lib/email/guard";
import { sendClientInviteEmail } from "@/lib/email/send";
import { resolveOrCreateAuthUser, generateClientSetupLink } from "@/lib/clients/portal-login";
import { ORG_TYPES } from "@/lib/clients/org-types";

// The client's OWN first-login profile review + teammate invite (#16).
//
// Client members are read-only under RLS (0055), so these writes run as the
// SERVICE role -- but they are HARD-SCOPED to the caller's OWN org: the clientId
// always comes from requireClient()'s membership, NEVER from the submitted form,
// so a client can only ever read/write their own row. Same pattern as the staff
// portal-actions, just gated by requireClient instead of requireAdmin.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

export interface ConfirmState {
  ok: boolean;
  error?: string;
}

// Confirm + fill the org profile, then stamp profile_confirmed_at so the portal
// stops redirecting to /welcome. Returns a result (the client navigates to the
// dashboard on ok) rather than redirecting server-side -- mirrors set-password.
export async function confirmProfileAction(formData: FormData): Promise<ConfirmState> {
  const { memberships } = await requireClient();
  const clientId = memberships[0]?.clientId;
  if (!clientId) return { ok: false, error: "No organization is linked to your account." };

  const admin = createServiceClient();

  // Load the existing intake_data so the narrative merge never clobbers other keys
  // (programs, partnerships, ...) a staffer may already have captured.
  const { data: existing } = await admin
    .from("clients")
    .select("intake_data")
    .eq("id", clientId)
    .maybeSingle<{ intake_data: Record<string, unknown> | null }>();

  const orgTypeRaw = str(formData.get("org_type"));
  const orgType = orgTypeRaw && (ORG_TYPES as readonly string[]).includes(orgTypeRaw) ? orgTypeRaw : null;

  const mission = str(formData.get("mission"));
  const fundingNeed = str(formData.get("funding_need"));
  const intake_data: Record<string, unknown> = { ...(existing?.intake_data ?? {}) };
  if (mission !== null) intake_data.mission = mission;
  if (fundingNeed !== null) intake_data.funding_need = fundingNeed;

  const { error } = await admin
    .from("clients")
    .update({
      org_type: orgType,
      website: str(formData.get("website")),
      primary_contact_name: str(formData.get("contact_name")),
      location_city: str(formData.get("location_city")),
      location_county: str(formData.get("location_county")),
      location_state: str(formData.get("location_state")),
      location_street: str(formData.get("location_street")),
      location_zip: str(formData.get("location_zip")),
      intake_data,
      profile_confirmed_at: new Date().toISOString(),
    })
    .eq("id", clientId);

  if (error) return { ok: false, error: "Couldn't save your profile. Please try again." };

  revalidatePath("/portal");
  return { ok: true };
}

export interface TeammateState {
  ok: boolean;
  error?: string;
  invitedEmail?: string;
  emailed?: boolean;
}

// Invite a teammate to the caller's OWN org portal (the "2nd user"). Provisions
// the login + emails a Welcome setup link (gated exactly like every outreach
// send). Enforces the org's seat_limit; invited clients get 2 seats, so the
// primary can add one teammate before staff need to raise the limit.
export async function inviteTeammateAction(formData: FormData): Promise<TeammateState> {
  const { memberships } = await requireClient();
  const org = memberships[0];
  if (!org?.clientId) return { ok: false, error: "No organization is linked to your account." };
  const clientId = org.clientId;

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const contactName = String(formData.get("teammate_name") || "").trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };

  const admin = createServiceClient();

  // Seat gate: members on THIS org vs its seat_limit.
  const { data: client } = await admin
    .from("clients")
    .select("seat_limit")
    .eq("id", clientId)
    .maybeSingle<{ seat_limit: number }>();
  const seatLimit = client?.seat_limit ?? 1;
  const { count: used } = await admin
    .from("client_members")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if ((used ?? 0) >= seatLimit) {
    return {
      ok: false,
      error: `You've used all ${seatLimit} seat${seatLimit === 1 ? "" : "s"} on your plan. Ask your GRANTED contact to add more.`,
    };
  }

  // Already on this org's portal?
  const { data: dup } = await admin
    .from("client_members")
    .select("id")
    .eq("client_id", clientId)
    .eq("email", email)
    .maybeSingle();
  if (dup) return { ok: false, error: "That email is already on your team." };

  // Membership BEFORE the auth user, so on_auth_user_created links it (and does
  // NOT staff-profile it) -- see 0055.
  const { error: insErr } = await admin
    .from("client_members")
    .insert({ client_id: clientId, email, role: "member" });
  if (insErr) return { ok: false, error: "Couldn't add your teammate. Please try again." };

  let userId: string | null;
  try {
    userId = await resolveOrCreateAuthUser(admin, email);
  } catch {
    // Roll back the membership so nothing is left half-provisioned.
    await admin.from("client_members").delete().eq("client_id", clientId).eq("email", email);
    return { ok: false, error: "Couldn't create your teammate's login." };
  }
  if (userId) {
    await admin
      .from("client_members")
      .update({ user_id: userId, activated_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("email", email);
  }

  // Welcome email with the setup link -- gated exactly like every outreach send
  // (prod + enabled + on the allowlist). Non-fatal: the login exists regardless.
  let emailed = false;
  const gate = canSendOutreach(email);
  if (gate.ok) {
    try {
      const url = await generateClientSetupLink(admin, email);
      await sendClientInviteEmail({ to: email, contactName, orgName: org.clientName || "your organization", url });
      emailed = true;
    } catch (e) {
      console.error("[teammate-invite] welcome email failed:", e instanceof Error ? e.message : e);
    }
  } else {
    console.log(`[teammate-invite] welcome email skipped: ${gate.reason}`);
  }

  revalidatePath("/welcome");
  return { ok: true, invitedEmail: email, emailed };
}
