import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { FirmGrantBotChat } from "@/components/grantbot/firm-grantbot-chat";

// The FIRM GrantBot — a roster-wide reasoning surface over every active client's PROFILE. Brick 1: a
// standalone admin-only page reachable at /grantbot, ephemeral (nothing persists), no switcher, no
// tools. Universal presence + the per-scope switcher are later bricks.
//
// Gated twice: requireAdmin (the roster aggregates internal profile fields — admin-only for the
// proof) and GRANTBOT_FIRM_ENABLED (notFound when off, so it is undiscoverable until flipped +
// redeployed, mirroring the route's 404).
export default async function FirmGrantBotPage() {
  await requireAdmin();
  if (!firmGrantbotEnabled()) notFound();
  return <FirmGrantBotChat />;
}
