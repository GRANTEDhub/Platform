import { requireClient } from "@/lib/auth";
import IntellEngineScopeClient from "./scope-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineScope() {
  await requireClient();
  return <IntellEngineScopeClient />;
}
