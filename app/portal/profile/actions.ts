"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireClient } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { parseNarrative, narrativeToIntakeData } from "@/lib/intake/narrative";
import { ORG_TYPES } from "@/lib/clients/org-types";
import { PORTAL_NEXT_COOKIE, sanitizePortalNext } from "@/lib/portal/next-destination";

// The client confirming their own profile (migration 0065's profile_confirmed_at).
//
// ONE ACTION, BOTH MOUNTS. This is the first-login gate's form (/welcome) and the
// standing profile page (/portal/profile) -- the same component, so the same write. The
// second implementation this replaced (/welcome's confirmProfileAction) did not set
// primary_funding_needs at all, so the screen the gate actually sent clients to was the
// one that never fed the matcher.
//
// SCOPE IS DELIBERATELY NARROW. A client may correct the facts about their own
// organization -- contact details, org type, mission, programs, what they need funded,
// priority areas -- and nothing else. It never touches engagement terms, matcher
// configuration, hard constraints, account_managed, or the auto-pulled citation columns.
// Those are staff's, and a client-facing form must not be able to reach them even by
// crafting a request: the update below lists its columns explicitly rather than spreading
// a parsed payload.
//
// The client id comes from the SESSION's membership, never from the form, so one
// client cannot post an update against another's record.
type ConfirmState = { ok: boolean; error?: string; next?: string };

// Columns this action is allowed to write. Explicit so an added form field cannot
// silently widen the write surface.
type ClientProfileUpdate = {
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  website: string | null;
  location_street: string | null;
  location_city: string | null;
  location_county: string | null;
  location_state: string | null;
  location_zip: string | null;
  // intake_data is NOT here: the narrative keys are merged in the database by
  // merge_client_intake (0079), which this action calls before the update below.
  profile_confirmed_at: string;
  primary_funding_needs?: string[];
  org_type?: string;
};

export async function confirmClientProfileAction(formData: FormData): Promise<ConfirmState> {
  const { memberships } = await requireClient();
  const org = memberships[0];
  if (!org) return { ok: false, error: "No client is linked to this login." };

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const admin = createServiceClient();
  const narrative = parseNarrative(get("intake_narrative"));

  // ── THE NARRATIVE MERGE HAPPENS FIRST, AND IN THE DATABASE ──
  //
  // Merged rather than replaced, as before: intake_data also carries keys written by the
  // public intake and the staff form that this page does not render, and a client confirming
  // their mission must not drop them. What changed is WHERE. This used to read the whole
  // column, spread the narrative over it in JS and write it back -- so a staff edit or an
  // assimilation commit landing in the same instant was silently erased. 0079 does the merge
  // under a row lock instead, so the patch applies to the committed value. Behaviour is
  // otherwise identical: narrativeToIntakeData always emits all seven keys, null for empties
  // and never undefined, so the same keys are written either way.
  //
  // BEFORE the update below, on purpose. That update sets profile_confirmed_at -- the
  // first-login gate. It must land LAST, so nothing can mark a client "confirmed" over a save
  // whose narrative did not persist: a client waved through the gate with an unsaved mission
  // is a worse outcome than a client asked to submit the form again.
  const { error: mergeError } = await admin.rpc("merge_client_intake", {
    p_client_id: org.clientId,
    p_patch: narrativeToIntakeData(narrative),
  });
  if (mergeError) return { ok: false, error: `Couldn't save your profile: ${mergeError.message}` };

  const update: ClientProfileUpdate = {
    primary_contact_name: get("primary_contact_name"),
    primary_contact_email: get("primary_contact_email"),
    primary_contact_phone: get("primary_contact_phone"),
    website: get("website"),
    location_street: get("location_street"),
    location_city: get("location_city"),
    location_county: get("location_county"),
    location_state: get("location_state"),
    location_zip: get("location_zip"),
    profile_confirmed_at: new Date().toISOString(),
  };

  // ── Two fields are ADDITIVE-ONLY: absent means "leave it alone", never "clear it" ──
  //
  // Both are staff-set and load-bearing, and this form is now mandatory on first login --
  // so an empty submit is something every client does once, not an edge case. Writing the
  // empty value would let a client who skipped a field silently erase work behind it. The
  // ordinary contact/location fields above are NOT treated this way on purpose: a client
  // blanking their own phone number means they want it gone.

  // The matcher reads primary_funding_needs directly, so the client's own priority areas
  // land there as well as in the narrative -- but a submit with none selected leaves what
  // staff captured intact rather than nulling the column.
  if (narrative.priority_areas.length) update.primary_funding_needs = narrative.priority_areas;

  // org_type is validated against the shared allowlist rather than stored as free text
  // from the form. It also decides eligibility framing and is the column migration 0065
  // keyed its first-login exemption on, so an accidental blank is expensive.
  const orgType = get("org_type");
  if (orgType && (ORG_TYPES as readonly string[]).includes(orgType)) update.org_type = orgType;

  const { error } = await admin.from("clients").update(update).eq("id", org.clientId);
  if (error) return { ok: false, error: `Couldn't save your profile: ${error.message}` };

  // Where they were actually headed before the first-login gate intercepted them (an
  // alert email's /portal/triage?card=... deep link). Read and cleared here, the one
  // point where the gate is known to be satisfied.
  const jar = cookies();
  const next = sanitizePortalNext(jar.get(PORTAL_NEXT_COOKIE)?.value);
  if (next) jar.set(PORTAL_NEXT_COOKIE, "", { path: "/", maxAge: 0 });

  revalidatePath("/portal");
  revalidatePath("/portal/profile");
  // /welcome renders this same form; without this it can serve a cached pre-confirm copy.
  revalidatePath("/welcome");
  return { ok: true, next: next ?? undefined };
}
