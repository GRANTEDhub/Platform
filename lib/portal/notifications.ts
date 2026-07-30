import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { CardDecision } from "@/types/database";

// The client's "things needing attention", derived from review_cards state.
// There is NO notifications table — a client's actionable items are entirely a
// function of their cards' triage/decision state plus the team's next_step note.
// This is the single source of truth shared by the header notification bell AND
// the dashboard action-items list (app/portal/page.tsx), so the two can't drift.

export interface ClientNotificationItem {
  id: string;
  title: string;
  href: string | null;
  tag?: string | null;
  priority?: "high" | "medium" | null;
}

export interface ClientNotifications {
  // Badge count = actionable GRANT items only (new alerts + awaiting-decision).
  // The team's next_step note is surfaced in the list but deliberately not
  // counted — it's context, not a task the client must clear.
  count: number;
  items: ClientNotificationItem[];
  newAlerts: number;
  pending: number;
}

// Only the fields the derivation actually reads — kept minimal so callers that
// already hold richer card rows (the dashboard) can pass them straight through.
export type NotificationCard = {
  decision: CardDecision;
  interested_at: string | null;
  sme_released_at: string | null;
};

// Pure derivation — no I/O. Given the client's cards, whether they're
// account-managed, and the team's next_step, produce the notification set.
export function deriveClientNotifications({
  cards,
  managed,
  nextStep,
  profileConfirmed = true,
}: {
  cards: NotificationCard[];
  managed: boolean;
  nextStep: string | null;
  // clients.profile_confirmed_at (migration 0065). Until the client has confirmed
  // their profile, that is their ONLY action item -- grants stay counted but unlisted.
  // Defaults true so every existing caller keeps its current behaviour.
  profileConfirmed?: boolean;
}): ClientNotifications {
  // Account-managed clients (0059) must never be alerted to a card staff hasn't
  // released yet — the same sme_released_at gate the dashboard applies before it
  // counts anything. Standard clients see every card.
  const visible = managed ? cards.filter((c) => c.sme_released_at !== null) : cards;

  // New Grant Alerts: matched but not yet triaged (past neither the interest
  // gate nor an archive). Awaiting decision: interested-but-undecided, sitting
  // in the Grant Report. Mirrors app/portal/page.tsx exactly.
  const newAlerts = visible.filter((c) => c.interested_at === null && c.decision !== "passed").length;
  const pending = visible.filter((c) => c.interested_at !== null && c.decision === "pending").length;

  const items: ClientNotificationItem[] = [];

  // FIRST LOGIN: confirming the profile is the only thing on the list. Everything the
  // client could otherwise click leads to grants matched against a profile they have
  // not yet vouched for, so asking them to review those first inverts the order the
  // work actually depends on. The COUNT below is unaffected -- the bell still reflects
  // reality; this only decides what is asked of them now.
  if (!profileConfirmed) {
    return {
      count: newAlerts + pending,
      items: [
        {
          id: "confirm-profile",
          title: "Confirm your organization's profile",
          tag: "Takes a minute — it sharpens your matches",
          priority: "high",
          href: "/portal/profile",
        },
      ],
      newAlerts,
      pending,
    };
  }

  if (newAlerts > 0) {
    items.push({
      id: "grant-alerts",
      title: `You have ${newAlerts} grant${newAlerts === 1 ? "" : "s"} to review`,
      href: "/portal/triage",
    });
  }
  if (pending > 0) {
    items.push({
      id: "grant-report-pending",
      title: `${pending} grant${pending === 1 ? "" : "s"} awaiting a decision`,
      href: "/portal/grants",
    });
  }
  if (nextStep) {
    items.push({ id: "next-step", title: nextStep, tag: "From your team", priority: "high", href: null });
  }

  return { count: newAlerts + pending, items, newAlerts, pending };
}

// Fetch-and-derive for the header bell. Reads under the caller's RLS (the
// request-scoped cookie client, never the service role): the 0055 policies
// already scope clients + review_cards to the signed-in client's own org.
export async function getClientNotifications(clientId: string): Promise<ClientNotifications> {
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed, next_step")
    .eq("id", clientId)
    .single<{ account_managed: boolean | null; next_step: string | null }>();

  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("decision, interested_at, sme_released_at")
    .eq("client_id", clientId)
    .neq("card_type", "prospect");

  return deriveClientNotifications({
    cards: (cardRows ?? []) as NotificationCard[],
    managed: !!client?.account_managed,
    nextStep: client?.next_step ?? null,
  });
}
