import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { FirmGrantBotChat } from "@/components/grantbot/firm-grantbot-chat";

// The FIRM GrantBot — a roster-wide reasoning surface over every active client's PROFILE. A
// standalone admin-only page reachable at /grantbot. PERSISTED across sessions (Memory / Brick 2,
// migration 0097: firm threads are grantbot_conversations rows with scope='firm'), with inline thread
// RENAME and two read-only CROSS-THREAD tools (the bot reaching its other firm threads). Universal
// presence + the switcher are later bricks.
//
// Gated twice: requireAdmin (the roster aggregates internal profile fields — admin-only for the
// proof) and GRANTBOT_FIRM_ENABLED (notFound when off, so it is undiscoverable until flipped +
// redeployed, mirroring the route's 404).
export default async function FirmGrantBotPage({
  searchParams,
}: {
  searchParams?: { ask?: string };
}) {
  await requireAdmin();
  if (!firmGrantbotEnabled()) notFound();
  // The switcher-OFF fallback of the prospecting page's "Ask GrantBot" navigates here with ?ask=1 so the
  // chat starts a NEW blank thread (the grant anchor rides the firm ask-context stash, read on mount).
  // With the Switcher ON (the prod default) the button opens the corner in place and never reaches here.
  return <FirmGrantBotChat initialBlank={searchParams?.ask === "1"} />;
}
