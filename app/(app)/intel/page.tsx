import { requireAdmin } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

// Grant Intel = Track 2 (prospects / BizDev). Reads the same grant shred as
// Grant Matches, but scores against non-client orgs the platform finds itself.
// Admin-only; the prospect engine is a later phase, so this is a stub for now.
export default async function IntelPage() {
  await requireAdmin();
  return (
    <ComingSoon
      title="Grant Intel"
      description="Track 2 -- prospect and BizDev matches. Open a grant's shred, hit Prospect, and surface non-client orgs (Arkansas first) that fit the opportunity."
      phase="the prospect-engine phase"
    />
  );
}
