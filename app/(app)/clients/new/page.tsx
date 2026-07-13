import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "../client-form";
import { createClientAction } from "../actions";

// createClientAction fires a one-time prospect match in a background waitUntil.
// The waitUntil inherits this page's function budget, so raise it to the 300s cap
// (default 10-15s) to give the pool-scoring run room. HARD PREVIEW GATE: confirm
// on a real preview deploy that this page-level maxDuration actually extends the
// server-action's waitUntil to 300s; if it does not hold, the run must move to a
// dedicated route/fn with its own maxDuration.
export const maxDuration = 300;

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
