import { requireUser } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function GrantsPage() {
  await requireUser(); // admins + contractors
  return (
    <ComingSoon
      title="Grant Intelligence"
      description="Ingest, shred, and match federal opportunities (domestic-only)."
      phase="Phase 3"
    />
  );
}
