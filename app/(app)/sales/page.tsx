import { requireAdmin } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function SalesPage() {
  await requireAdmin();
  return (
    <ComingSoon
      title="Sales"
      description="Inbound and outbound pipeline -- prospects, leads, and grant-driven outreach."
      phase="a later phase"
    />
  );
}
