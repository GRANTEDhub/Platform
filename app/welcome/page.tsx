import { redirect } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ConfirmProfile } from "@/components/portal/confirm-profile";
import { confirmClientProfileAction } from "@/app/portal/profile/actions";
import { narrativeFromClient } from "@/lib/intake/narrative";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// First-login profile review (#16). The portal layout redirects an unconfirmed client
// here; they review the org details we already built from their website and our intake,
// correct what's wrong, and confirm — which stamps profile_confirmed_at and drops them
// into the portal (or into the grant they were deep-linked to).
//
// This route lives OUTSIDE the portal layout on purpose, so its gate can't loop back
// onto itself. Reads run under RLS as the client (own row only).
//
// SAME FORM AS /portal/profile. It renders ConfirmProfile and confirmClientProfileAction
// rather than a form of its own. It used to have its own simpler pair, which meant the
// screen the gate actually sent every new client to was the one that captured no programs
// and no priority areas, and never wrote primary_funding_needs — the column the matcher
// reads. The only thing unique to first login is now the copy -- the teammate invite that
// used to sit below the form is unmounted, pending its own first-login action item.
export default async function WelcomePage() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  if (!org) redirect("/");

  const supabase = createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", org.clientId)
    .maybeSingle<Client>();
  if (!client) redirect("/portal");

  return (
    <div className="min-h-screen bg-page px-4 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8 text-center">
          <img src="/granted-lockup-light.svg" alt="GRANTED" className="mx-auto mb-6 h-11 w-auto" />
          <h1 className="font-serif text-2xl font-semibold text-brand-navy">
            Welcome to GRANTED, {org.clientName}
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
            Take a moment to confirm your organization&apos;s details. We built this from{" "}
            {client.website ? "your website" : "our intake"} and our research — correct anything
            that&apos;s wrong and add what we missed. This is what your grant matches are scored
            against.
          </p>
        </div>

        <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-8 shadow-grounded">
          <ConfirmProfile
            orgName={client.name}
            firstLogin
            defaults={{
              org_type: client.org_type,
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

          {/* TEAMMATE INVITE IS UNMOUNTED, NOT DELETED. It is coming back as its own
              first-login action item rather than a second task bolted onto the bottom of the
              verification form, so components/portal/teammate-invite.tsx and
              inviteTeammateAction (app/welcome/actions.ts) are both left intact and working.
              Only this mount is gone -- reintroducing it is re-adding a block here, not
              rebuilding a feature. */}
        </div>
      </div>
    </div>
  );
}
