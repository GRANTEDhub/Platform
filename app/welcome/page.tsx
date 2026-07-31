import { redirect } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { WelcomeForm, type WelcomeDefaults } from "./welcome-form";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// First-login profile review (#16). The portal layout redirects an unconfirmed
// client here; they review the org details staff prefilled at invite (org_type /
// location / narrative are deliberately blank there), fill what's missing, and
// confirm — which stamps profile_confirmed_at and drops them into the dashboard.
// This route lives OUTSIDE the portal layout on purpose, so its gate can't loop
// back onto itself. Reads run under RLS as the client (own row only).
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

  const intake = (client.intake_data ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const defaults: WelcomeDefaults = {
    org_type: client.org_type ?? "",
    website: client.website ?? "",
    contact_name: client.primary_contact_name ?? "",
    location_city: client.location_city ?? "",
    location_county: client.location_county ?? "",
    location_state: client.location_state ?? "",
    location_street: client.location_street ?? "",
    location_zip: client.location_zip ?? "",
    mission: s(intake.mission),
    funding_need: s(intake.funding_need),
  };

  return (
    <div className="min-h-screen bg-page px-4 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 text-center">
          <img src="/granted-lockup-light.svg" alt="GRANTED" className="mx-auto mb-6 h-11 w-auto" />
          <h1 className="font-serif text-2xl font-semibold text-brand-navy">Welcome to GRANTED, {org.clientName}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Take a moment to confirm your organization&apos;s details. This is what our team uses to match you to the
            right grants — the more accurate it is, the better your matches.
          </p>
        </div>

        <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-8 shadow-grounded">
          <WelcomeForm orgName={org.clientName} defaults={defaults} />
        </div>
      </div>
    </div>
  );
}
