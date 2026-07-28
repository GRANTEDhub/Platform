import { requireClient } from "@/lib/auth";
import { HubShell } from "@/components/layout/hub-background";
import { DecidedConfirmation } from "@/components/report/decided-confirmation";

export const dynamic = "force-dynamic";

// #18c: the brief "decision recorded" transition a client sees after passing or saving
// a grant on the Grant Report detail, before being routed back to the report. Auth-gated
// like the rest of the portal (requireClient); the outcome label comes from `?o=`.
export default async function GrantDecidedPage({ searchParams }: { searchParams: { o?: string } }) {
  await requireClient();
  return (
    <HubShell variant="texture">
      <DecidedConfirmation outcome={searchParams.o ?? "approved"} />
    </HubShell>
  );
}
