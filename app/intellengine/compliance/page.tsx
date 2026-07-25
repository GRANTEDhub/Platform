import { requireClientOrAdmin } from "@/lib/auth";
import IntellEngineComplianceClient from "./compliance-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineCompliance({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  return <IntellEngineComplianceClient draftId={searchParams.draft} />;
}
