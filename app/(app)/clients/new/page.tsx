import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "../client-form";
import { createClientAction } from "../actions";

// createClientAction runs enrichClient in a background waitUntil (the one-time
// prospect match is no longer run here -- it is drained by /api/cron/client-match).
// The waitUntil inherits this page's function budget, so give enrichClient (a
// USASpending cache + one profile-refine call) modest headroom above the ~15s
// default; the heavy pool-scoring work lives in the drain, not here.
export const maxDuration = 60;

export default async function NewClientPage() {
  await requireAdmin();

  return (
    <div>
      <PageHeader title="Add Client/Prospect" description="Create a new client or prospect record." />
      <div className="p-8">
        <ClientForm action={createClientAction} submitLabel="Create record" />
      </div>
    </div>
  );
}
