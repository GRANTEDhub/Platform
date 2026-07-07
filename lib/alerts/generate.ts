import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { Grant, ReviewCard, Client, Prospect } from "@/types/database";

// Server-side context loader for the grant alert, shared by the alert routes.
// Service-role reads (review cards + grants are admin-only). Enrich + render +
// persist live in lib/alerts/store.ts (generateDraftAlert). A card is EITHER a
// client card (client_id set) or a prospect card (prospect_id set); the recipient
// is resolved from whichever applies.

type AlertClient = Pick<Client, "id" | "name" | "primary_contact_email" | "primary_contact_name">;
type AlertProspect = Pick<Prospect, "id" | "name" | "primary_contact_email" | "primary_contact_name">;

export type AlertContext = {
  card: ReviewCard;
  grant: Grant;
  client: AlertClient | null;
  prospect: AlertProspect | null;
};

// The send recipient (email + greeting name + org), from the client or prospect.
export type AlertRecipient = { email: string; name: string | null; orgName: string; kind: "client" | "prospect" };

export function alertRecipient(ctx: AlertContext): AlertRecipient {
  if (ctx.card.card_type === "prospect" || ctx.prospect) {
    return {
      email: (ctx.prospect?.primary_contact_email ?? "").trim(),
      name: ctx.prospect?.primary_contact_name ?? null,
      orgName: ctx.prospect?.name ?? "",
      kind: "prospect",
    };
  }
  return {
    email: (ctx.client?.primary_contact_email ?? "").trim(),
    name: ctx.client?.primary_contact_name ?? null,
    orgName: ctx.client?.name ?? "",
    kind: "client",
  };
}

export async function loadAlertContext(cardId: string): Promise<AlertContext | null> {
  const db = createServiceClient();
  const { data: card } = await db.from("review_cards").select("*").eq("id", cardId).single<ReviewCard>();
  if (!card || !card.grant_id) return null;
  const { data: grant } = await db.from("grants").select("*").eq("id", card.grant_id).single<Grant>();
  if (!grant) return null;

  const client = card.client_id
    ? (
        await db
          .from("clients")
          .select("id, name, primary_contact_email, primary_contact_name")
          .eq("id", card.client_id)
          .single<AlertClient>()
      ).data
    : null;
  const prospect = card.prospect_id
    ? (
        await db
          .from("prospects")
          .select("id, name, primary_contact_email, primary_contact_name")
          .eq("id", card.prospect_id)
          .single<AlertProspect>()
      ).data
    : null;

  return { card, grant, client, prospect };
}
