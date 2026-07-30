"use server";

import { revalidatePath } from "next/cache";
import { requireClient } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { parseNarrative, narrativeToIntakeData } from "@/lib/intake/narrative";

// The client confirming their own profile (migration 0065's profile_confirmed_at).
//
// SCOPE IS DELIBERATELY NARROW. A client may correct the facts about their own
// organization -- contact details, mission, programs, what they need funded, priority
// areas -- and nothing else. It never touches engagement terms, matcher configuration,
// hard constraints, account_managed, or the auto-pulled citation columns. Those are
// staff's, and a client-facing form must not be able to reach them even by crafting a
// request: the update below lists its columns explicitly rather than spreading a
// parsed payload.
//
// The client id comes from the SESSION's membership, never from the form, so one
// client cannot post an update against another's record.
type ConfirmState = { ok: boolean; error?: string };

export async function confirmClientProfileAction(formData: FormData): Promise<ConfirmState> {
  const { memberships } = await requireClient();
  const org = memberships[0];
  if (!org) return { ok: false, error: "No client is linked to this login." };

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const admin = createServiceClient();
  const { data: existing } = await admin
    .from("clients")
    .select("intake_data")
    .eq("id", org.clientId)
    .single<{ intake_data: Record<string, unknown> | null }>();

  const narrative = parseNarrative(get("intake_narrative"));

  // Merge rather than replace: intake_data also carries keys written by the public
  // intake and the staff form that this page does not render, and a client confirming
  // their mission must not drop them.
  const intake_data = {
    ...(existing?.intake_data ?? {}),
    ...narrativeToIntakeData(narrative),
  };

  const { error } = await admin
    .from("clients")
    .update({
      primary_contact_name: get("primary_contact_name"),
      primary_contact_email: get("primary_contact_email"),
      primary_contact_phone: get("primary_contact_phone"),
      website: get("website"),
      location_street: get("location_street"),
      location_city: get("location_city"),
      location_county: get("location_county"),
      location_state: get("location_state"),
      location_zip: get("location_zip"),
      intake_data,
      // The matcher reads this column directly, so the client's own priority areas
      // land there as well as in the narrative.
      primary_funding_needs: narrative.priority_areas.length ? narrative.priority_areas : null,
      profile_confirmed_at: new Date().toISOString(),
    })
    .eq("id", org.clientId);
  if (error) return { ok: false, error: `Couldn't save your profile: ${error.message}` };

  revalidatePath("/portal");
  revalidatePath("/portal/profile");
  return { ok: true };
}
