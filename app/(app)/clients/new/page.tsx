import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "../client-form";
import { createClientAction } from "../actions";

export default async function NewClientPage() {
  await requireAdmin();

  return (
    <div>
      <PageHeader title="Add client" description="Create a new client record." />
      <div className="p-8">
        <ClientForm action={createClientAction} submitLabel="Create client" />
      </div>
    </div>
  );
}
