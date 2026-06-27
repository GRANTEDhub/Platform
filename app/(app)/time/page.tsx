import { requireAdmin } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function TimePage() {
  await requireAdmin();
  return (
    <ComingSoon
      title="Time Tracking"
      description="Log billable hours against a client."
      phase="Phase 4"
    />
  );
}
