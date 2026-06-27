import { requireUser } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function ReviewPage() {
  await requireUser(); // admins + contractors
  return (
    <ComingSoon
      title="Review Queue"
      description="Approve or pass on matches before anything reaches a client."
      phase="Phase 3"
    />
  );
}
