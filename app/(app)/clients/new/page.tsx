import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { FormExitGuard } from "@/components/clients/form-exit-guard";
import { ClientForm } from "../client-form";
import { createClientAction } from "../actions";

// createClientAction runs enrichClient in a background waitUntil (the one-time
// prospect match is no longer run here -- it is drained by /api/cron/client-match).
// The waitUntil inherits this page's function budget, so give enrichClient (a
// USASpending cache + one profile-refine call) modest headroom above the ~15s
// default; the heavy pool-scoring work lives in the drain, not here.
export const maxDuration = 60;

export default async function NewClientPage({
  searchParams,
}: {
  searchParams: { kind?: string };
}) {
  // Any staff (0077), matching clients_insert. Note this form also runs in prospect mode
  // (?kind=prospect), so creating a PROSPECT record rides along -- deliberately. Creating a
  // record is not contacting one: cold outreach to non-clients stays admin-only, both in
  // the send route and in the prospects RLS.
  await requireUser();
  // No record-type toggle anymore: the entry point fixes the kind. This is the
  // "Add client" door (prospects have their own at /intel/prospects/new); a legacy
  // ?kind=prospect link still resolves to a prospect.
  const defaultKind: "client" | "prospect" = searchParams.kind === "prospect" ? "prospect" : "client";

  return (
    <div>
      <div className="px-8 pt-6">
        <FormExitGuard
          backHref={defaultKind === "prospect" ? "/intel" : "/clients"}
          backLabel={defaultKind === "prospect" ? "Prospecting" : "Clients"}
        />
      </div>
      <PageHeader
        title={defaultKind === "prospect" ? "Add prospect" : "Add client"}
        description={defaultKind === "prospect" ? "Create a new prospect record." : "Create a new client record."}
      />
      {defaultKind !== "prospect" && (
        <div className="mx-8 mt-4 rounded-xl border border-brand-navy/[0.08] bg-brand-cream/40 px-4 py-3 text-sm text-muted-foreground">
          Prefer the client complete it themselves?{" "}
          <Link href="/clients/invite" className="font-medium text-brand-orange hover:underline">
            Invite them to set up their own account →
          </Link>
        </div>
      )}
      <div className="p-8">
        <ClientForm action={createClientAction} submitLabel="Create record" defaultKind={defaultKind} />
      </div>
    </div>
  );
}
