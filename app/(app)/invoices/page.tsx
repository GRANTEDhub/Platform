import { requireAdmin } from "@/lib/auth";
import { ComingSoon } from "@/components/layout/coming-soon";

export default async function InvoicesPage() {
  await requireAdmin();
  return (
    <ComingSoon
      title="Invoicing"
      description="Track what's billed, what's paid, and credit-hour balances. Stripe-backed."
      phase="Phase 4"
    />
  );
}
