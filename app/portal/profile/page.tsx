import { notFound } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ConfirmProfile } from "@/components/portal/confirm-profile";
import { confirmClientProfileAction } from "./actions";
import { narrativeFromClient } from "@/lib/intake/narrative";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// The client's own profile page. On first login it is their ONLY action item (see
// lib/portal/notifications.ts); afterwards it stays reachable so they can correct
// things as the organization changes.
//
// Prepopulated from what we already built off their website + intake, so this is a
// review pass rather than data entry -- which is what makes it reasonable to ask a
// client to do at all.
export default async function PortalProfilePage() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  if (!org) notFound();

  const supabase = createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", org.clientId)
    .single<Client>();
  if (!client) notFound();

  const firstTime = !client.profile_confirmed_at;

  return (
    <div>
      <PageHeader title={firstTime ? "Confirm your profile" : "Your profile"} />
      <div className="max-w-3xl space-y-6 p-8">
        <p className="text-sm text-muted-foreground">
          {firstTime
            ? `We built this from ${client.website ? "your website" : "our intake"} and our research. Correct anything that's wrong and add what we missed — this is what your grant matches are scored against.`
            : "Keep this current — it's what your grant matches are scored against."}
        </p>

        <ConfirmProfile
          orgName={client.name}
          defaults={{
            primary_contact_name: client.primary_contact_name,
            primary_contact_email: client.primary_contact_email,
            primary_contact_phone: client.primary_contact_phone,
            website: client.website,
            location_street: client.location_street,
            location_city: client.location_city,
            location_county: client.location_county,
            location_state: client.location_state,
            location_zip: client.location_zip,
          }}
          narrativeDefault={narrativeFromClient(client)}
          action={confirmClientProfileAction}
        />
      </div>
    </div>
  );
}
