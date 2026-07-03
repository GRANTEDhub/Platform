import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "../../client-form";
import { SamRegistration } from "../../sam-registration";
import { updateClientAction } from "../../actions";
import type { Client } from "@/types/database";

export default async function EditClientPage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdmin();
  const supabase = createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .single<Client>();

  if (!client) notFound();

  const action = updateClientAction.bind(null, client.id);

  return (
    <div>
      <PageHeader title={`Edit ${client.name}`} />
      <div className="max-w-3xl space-y-8 p-8">
        <ClientForm client={client} action={action} submitLabel="Save changes" />
        <SamRegistration client={client} />
      </div>
    </div>
  );
}
