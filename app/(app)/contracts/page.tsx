import { requireAdmin } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function ContractsPage() {
  await requireAdmin();
  return (
    <ComingSoon
      title="Contracts"
      description="Engagement letters and the contract lifecycle for each client."
      phase="a later phase"
    />
  );
}
