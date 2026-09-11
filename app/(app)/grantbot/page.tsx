import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { FirmGrantBotChat } from "@/components/grantbot/firm-grantbot-chat";

// The FIRM GrantBot — a roster-wide reasoning surface over every active client's PROFILE. A
// standalone admin-only page reachable at /grantbot. PERSISTED across sessions (Memory / Brick 2,
// migration 0097: firm threads are grantbot_conversations rows with scope='firm'); still no tools
// and no switcher. Cross-thread + rename, then universal presence + the switcher, are later bricks.
//
// Gated twice: requireAdmin (the roster aggregates internal profile fields — admin-only for the
// proof) and GRANTBOT_FIRM_ENABLED (notFound when off, so it is undiscoverable until flipped +
// redeployed, mirroring the route's 404).
export default async function FirmGrantBotPage() {
  await requireAdmin();
  if (!firmGrantbotEnabled()) notFound();
  return <FirmGrantBotChat />;
}
