import { requireClientOrAdmin } from "@/lib/auth";
import IntellEngineBuildClient from "./build-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineBuild({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  return <IntellEngineBuildClient draftId={searchParams.draft} />;
}
