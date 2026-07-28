"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { canSendOutreach } from "@/lib/email/guard";
import { sendClientInviteEmail } from "@/lib/email/send";
import { resolveOrCreateAuthUser, generateClientSetupLink } from "@/lib/clients/portal-login";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface InviteState {
  ok: boolean;
  error?: string;
  invitedName?: string;
  invitedEmail?: string;
  emailed?: boolean;
}

// Lean "Invite client" onboarding flow. From a just-finished discovery call we
// know the org name, the point of contact, and the chosen package -- so create a
// MINIMAL active client (package -> account_managed tier), provision their portal
// login, and email a Welcome-to-GRANTED link that lets them set a password and
// (in #16) review their prefilled profile. org_type / location / narrative are
// deliberately left blank for the client to fill at that review; only name +
// status are NOT-NULL on clients. Contract + Stripe invoice stay separate staff
// actions, not gated into this path.
export async function inviteClientAction(formData: FormData): Promise<InviteState> {
  await requireAdmin();

  const name = String(formData.get("name") || "").trim();
  const contactName = String(formData.get("contact_name") || "").trim();
  const email = String(formData.get("contact_email") || "").trim().toLowerCase();
  const pkg = String(formData.get("package") || "").trim().toLowerCase();

  if (!name) return { ok: false, error: "Enter the organization name." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid contact email." };
  if (pkg !== "build" && pkg !== "enterprise") return { ok: false, error: "Choose a package." };

  const admin = createServiceClient();
  const accountManaged = pkg === "enterprise";
  const tierLabel = pkg === "enterprise" ? "Enterprise" : "Build";

  // 1) Minimal active client. intake_sent_at stamps the "invited" badge.
  const { data: client, error: cErr } = await admin
    .from("clients")
    .insert({
      name,
      status: "active",
      primary_contact_name: contactName || null,
      primary_contact_email: email,
      engagement_tier: tierLabel,
      account_managed: accountManaged,
      intake_sent_at: new Date().toISOString(),
      // Two seats so the primary contact can add one teammate at first login
      // (#16); staff raise it per the pricing tier for larger orgs.
      seat_limit: 2,
    })
    .select("id")
    .single<{ id: string }>();
  if (cErr || !client) {
    const dup = /duplicate|unique/i.test(cErr?.message ?? "");
    return { ok: false, error: dup ? "A client with that name already exists." : "Couldn't create the client record." };
  }

  // 2) Membership BEFORE the auth user, so on_auth_user_created links it (0055).
  //    The primary contact is the 'primary' member.
  const { error: mErr } = await admin
    .from("client_members")
    .insert({ client_id: client.id, email, role: "primary" });
  if (mErr) {
    await admin.from("clients").delete().eq("id", client.id);
    return { ok: false, error: "Couldn't set up the client's login." };
  }

  // 3) Provision the login; roll back BOTH writes on a genuine failure so nothing
  //    is left half-created.
  let userId: string | null;
  try {
    userId = await resolveOrCreateAuthUser(admin, email);
  } catch {
    await admin.from("client_members").delete().eq("client_id", client.id);
    await admin.from("clients").delete().eq("id", client.id);
    return { ok: false, error: "Couldn't create the client's login." };
  }
  if (userId) {
    await admin
      .from("client_members")
      .update({ user_id: userId, activated_at: new Date().toISOString() })
      .eq("client_id", client.id)
      .eq("email", email);
  }

  // 4) Welcome email with the setup link -- gated exactly like every outreach
  //    send (prod + enabled + on the allowlist). Non-fatal: the client + login
  //    exist regardless; a gated or failed send simply isn't sent, and the staff
  //    UI reports whether it went.
  let emailed = false;
  const gate = canSendOutreach(email);
  if (gate.ok) {
    try {
      const url = await generateClientSetupLink(admin, email);
      await sendClientInviteEmail({ to: email, contactName, orgName: name, url });
      emailed = true;
    } catch (e) {
      console.error("[client-invite] welcome email failed:", e instanceof Error ? e.message : e);
    }
  } else {
    console.log(`[client-invite] welcome email skipped: ${gate.reason}`);
  }

  revalidatePath("/clients");
  return { ok: true, invitedName: name, invitedEmail: email, emailed };
}
