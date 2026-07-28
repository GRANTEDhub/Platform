import { requireClientOrAdmin } from "@/lib/auth";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { scopeSeedFrom } from "@/lib/intellengine/prepopulate";
import IntellEngineScopeClient from "./scope-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineScope({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  // Seed from the released concept proposal (premium) -> grant hints -> blank.
  // Resolves null for a staff preview (no client draft under RLS) -> blank canvas.
  const ctx = await resolveIntellEngineContext(searchParams.draft);
  const seed = scopeSeedFrom(ctx?.concept ?? null, ctx?.grant ?? null);
  return <IntellEngineScopeClient draftId={searchParams.draft} seed={seed} />;
}
