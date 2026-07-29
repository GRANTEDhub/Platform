import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { FormExitGuard } from "@/components/clients/form-exit-guard";
import { createClientAction } from "@/app/(app)/clients/actions";
import { ClientForm } from "@/app/(app)/clients/client-form";

// createClientAction runs enrichClient in a background waitUntil (the one-time
// prospect match is NOT run here -- it happens on demand via Generate report). The
// waitUntil inherits this page's budget, so give it modest headroom (mirrors
// /clients/new).
export const maxDuration = 60;

// Dedicated, lightweight "Add prospect" — the second door on the Prospecting landing.
// Separate from the full Add Client/Prospect form; posts to the same server action in
// prospect mode.
export default async function AddProspectPage() {
  await requireAdmin();

  return (
    <div className="p-6">
      {/* Back + unsaved-changes guard (replaces the plain Link so a half-filled
          profile isn't lost by navigating away). */}
      <FormExitGuard backHref="/intel" backLabel="Prospecting" />
      <div className="mt-4">
        <PageHeader
          title="Add prospect"
          description="A prospective client — staff-only, no portal, no daily matching. You'll generate their grant report on demand, then review and send one-pagers."
        />
      </div>
      <div className="mt-6">
        <ClientForm action={createClientAction} submitLabel="Add prospect" defaultKind="prospect" />
      </div>
    </div>
  );
}
