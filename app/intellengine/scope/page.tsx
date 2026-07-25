import { requireClientOrAdmin } from "@/lib/auth";
import IntellEngineScopeClient from "./scope-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineScope({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  return <IntellEngineScopeClient draftId={searchParams.draft} />;
}
