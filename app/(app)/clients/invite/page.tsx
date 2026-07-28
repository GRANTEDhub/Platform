import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { InviteClientForm } from "./invite-form";

// The lean "Invite client" entry: staff sends a new client a Welcome email to set
// up their own account + complete their profile, instead of populating everything
// by hand (that path is the full ClientForm at /clients/new). Admin-gated.
export default async function InviteClientPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Invite a client"
        description="Send a new client a welcome email to set up their account and complete their own profile."
      />
      <div className="p-8">
        <InviteClientForm />
      </div>
    </div>
  );
}
