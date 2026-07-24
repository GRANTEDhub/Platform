import { requireClientOrAdmin } from "@/lib/auth";
import IntellEngineScopeClient from "./scope-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineScope() {
  await requireClientOrAdmin();
  return <IntellEngineScopeClient />;
}
