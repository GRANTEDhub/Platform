import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { createClientAction } from "@/app/(app)/clients/actions";
import { AddProspectForm } from "../add-prospect-form";

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
      <Link
        href="/intel"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Prospecting
      </Link>
      <div className="mt-4">
        <PageHeader
          title="Add prospect"
          description="A prospective client — staff-only, no portal, no daily matching. You'll generate their grant report on demand, then review and send one-pagers."
        />
      </div>
      <div className="mt-6">
        <AddProspectForm action={createClientAction} />
      </div>
    </div>
  );
}
