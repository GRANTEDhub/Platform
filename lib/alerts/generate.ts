import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { enrichAlert } from "./enrich";
import { buildAlertData } from "./data";
import { renderAlertPdf, debugAlertFonts } from "./render";
import type { Grant, ReviewCard, Client } from "@/types/database";

// Shared server-side loading + rendering for the grant alert, used by the alert
// routes. Service-role reads (review cards + grants are admin-only).

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

// Full pipeline: enrich (narrative) + deterministic facts -> render PDF. The one
// place Chromium runs. Enrichment failures degrade to deterministic fallbacks.
export async function renderAlertPdfForCard(ctx: AlertContext): Promise<Buffer> {
  const enrichment = await enrichAlert(ctx.grant, ctx.card);
  const data = buildAlertData(ctx.grant, ctx.card, enrichment);
  return renderAlertPdf(data);
}

// Diagnostic path (admin, ?debug=fonts): reports whether the brand TTFs ship in
// the function and whether Chromium applies the embedded faces at render.
export async function debugAlertFontsForCard(ctx: AlertContext): Promise<Record<string, unknown>> {
  const enrichment = await enrichAlert(ctx.grant, ctx.card);
  const data = buildAlertData(ctx.grant, ctx.card, enrichment);
  return debugAlertFonts(data);
}
