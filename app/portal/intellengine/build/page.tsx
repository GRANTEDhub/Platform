import { requireClient } from "@/lib/auth";
import IntellEngineBuildClient from "./build-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineBuild() {
  await requireClient();
  return <IntellEngineBuildClient />;
}
