import Link from "next/link";
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

export default async function NewClientPage({
  searchParams,
}: {
  searchParams: { kind?: string };
}) {
  await requireAdmin();
  // The Prospecting landing's "Add prospect" entry links here with ?kind=prospect
  // so the record-type starts on prospect; still user-changeable.
  const defaultKind = searchParams.kind === "prospect" ? "prospect" : undefined;

  return (
    <div>
      <PageHeader title="Add Client/Prospect" description="Create a new client or prospect record." />
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
