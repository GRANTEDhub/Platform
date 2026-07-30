import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { WizardProgress } from "@/components/clients/wizard-progress";
import { CompleteProfile } from "@/components/clients/complete-profile";
import { completeClientProfileAction } from "../../actions";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// Step 7 (final) of client intake: engagement terms, then Complete profile.
//
// Engagement moved OFF the pre-create form and onto its own post-create step so the
// data pull (step 6) can run against a real record and be reviewed before the terms
// are set. A prospect has no engagement, so it has no step 7 -- its intake ends at
// the data-pull confirm.
export default async function FinishClientPage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();
  if (isUnconvertedLead(client.pipeline_stage)) redirect(`/clients/${client.id}`);

  const action = completeClientProfileAction.bind(null, client.id);

  return (
    <div>
      <PageHeader title={client.name} />
      <div className="max-w-3xl space-y-8 p-8">
        <WizardProgress step={7} total={7} title="Engagement" kindLabel="client" />
        <p className="text-sm text-muted-foreground">
          Last step. Set the engagement terms, then complete the profile.
        </p>

        <CompleteProfile
          clientId={client.id}
          clientName={client.name}
          contactEmail={client.primary_contact_email}
          action={action}
          current={{
            status: client.status,
            engagement_tier: client.engagement_tier,
            retainer_hours: client.retainer_hours,
            contract_start: client.contract_start,
            contract_end: client.contract_end,
            account_managed: !!client.account_managed,
          }}
        />

        <p className="text-xs text-muted-foreground">
          Need to change something earlier?{" "}
          <Link href={`/clients/${client.id}/edit`} className="underline">
            Edit the full profile
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
