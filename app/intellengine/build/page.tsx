import { requireClientOrAdmin } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import IntellEngineBuildClient from "./build-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineBuild({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  await requirePursuitVisible();
  return <IntellEngineBuildClient draftId={searchParams.draft} />;
}
