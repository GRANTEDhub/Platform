import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { Grant, ReviewCard, Client } from "@/types/database";

// Server-side context loader for the grant alert, shared by the alert routes.
// Service-role reads (review cards + grants are admin-only). Enrich + render +
// persist live in lib/alerts/store.ts (generateDraftAlert).

export type AlertContext = {
  card: ReviewCard;
  grant: Grant;
  client: Pick<Client, "id" | "name" | "primary_contact_email" | "primary_contact_name"> | null;
};

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
          .single<Pick<Client, "id" | "name" | "primary_contact_email" | "primary_contact_name">>()
      ).data
    : null;
  return { card, grant, client };
}
