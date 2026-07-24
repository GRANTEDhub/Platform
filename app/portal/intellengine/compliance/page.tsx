import { requireClient } from "@/lib/auth";
import IntellEngineComplianceClient from "./compliance-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineCompliance() {
  await requireClient();
  return <IntellEngineComplianceClient />;
}
