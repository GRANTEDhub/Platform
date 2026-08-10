import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { InviteClientForm } from "./invite-form";

// The lean "Invite client" entry: staff sends a new client a Welcome email to set
// up their own account + complete their profile, instead of populating everything
// by hand (that path is the full ClientForm at /clients/new). Admin-gated.
export default async function InviteClientPage() {
  // Any staff (0077). This invites an EXISTING client's contact into their portal, which is
  // client delivery work -- not cold outreach to a non-client.
  await requireUser();
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
