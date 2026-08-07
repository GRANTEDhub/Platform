import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pursuitClientAccessEnabled } from "@/lib/pursuit/access";
import type { IntellEngineDraft } from "@/types/database";

// Create (or resume) an IntellEngine proposal draft (migration 0062). Two callers:
//   - the Grant Report's pursuit chooser / the hub's "Develop a matched grant"
//     picker -> body { card_id } (the card's pursuit_path is set to 'intellengine'
//     separately, via PATCH /api/review/[id]; this route only owns the draft);
//   - the hub's "Start from scratch" -> body {} (card_id null).
// Everything runs under the caller's RLS. Two caller shapes:
//   - a CLIENT member: the target org is derived from their membership; body
//     client_id is ignored, so they can only ever draft for their own org.
//   - a STAFF user (admin or contractor): drafting on a client's behalf from the
//     console, so the target org comes from an EXPLICIT body.client_id. The 0062
//     staff RLS (is_staff()) permits the insert; this is draft-only and never
//     approves the card, so a contractor is fine here.
// Re-creating on the same card RESUMES the existing draft (one-per-card unique
// index) instead of duplicating.

type GrantEmbed = { title: string | null } | { title: string | null }[] | null;

function grantTitle(g: GrantEmbed): string | null {
  if (!g) return null;
  return (Array.isArray(g) ? g[0]?.title : g.title) ?? null;
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { card_id?: string | null; client_id?: string | null };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const cardId = body.card_id ?? null;

  // Resolve the target client org. A STAFF caller (has a profiles row) drafts on a
  // client's behalf, so the org comes from an explicit body.client_id. A CLIENT
  // member drafts for their OWN org (membership), ignoring any body.client_id.
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();

  // Pursuit is gated off for clients (lib/pursuit/access.ts). Hiding the chooser does
  // not close the endpoint it POSTs to, and without this a client could still mint
  // draft rows for a feature they cannot see. 404 rather than 403, matching what the
  // pages do -- the route is meant to look absent, not forbidden. Staff unaffected.
  if (!profile && !pursuitClientAccessEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let clientId: string | undefined;
  if (profile) {
    clientId = body.client_id ?? undefined;
    if (!clientId) return NextResponse.json({ error: "client_id required" }, { status: 400 });
  } else {
    const { data: membership } = await supabase
      .from("client_members")
      .select("client_id")
      .eq("user_id", user.id)
      .not("activated_at", "is", null)
      .order("invited_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ client_id: string }>();
    clientId = membership?.client_id;
    if (!clientId) return NextResponse.json({ error: "No client portal access" }, { status: 403 });
  }

  // From-scratch proposal: no grant, generic title.
  if (!cardId) {
    const { data, error } = await supabase
      .from("intellengine_drafts")
      .insert({ client_id: clientId, card_id: null, title: "Untitled proposal", status: "scope" })
      .select()
      .single<IntellEngineDraft>();
    if (error) return NextResponse.json({ error: "Couldn't start a proposal" }, { status: 500 });
    return NextResponse.json({ draft: data });
  }

  // Matched-grant proposal. Verify the card is this client's (RLS already scopes,
  // but pin it explicitly) and pull the grant title for the draft label.
  const { data: card } = await supabase
    .from("review_cards")
    .select("id, grants(title)")
    .eq("id", cardId)
    .eq("client_id", clientId)
    .maybeSingle<{ id: string; grants: GrantEmbed }>();
  if (!card) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  // Resume if a draft already exists for this card (one-per-card).
  const { data: existing } = await supabase
    .from("intellengine_drafts")
    .select("*")
    .eq("card_id", cardId)
    .maybeSingle<IntellEngineDraft>();
  if (existing) return NextResponse.json({ draft: existing });

  const title = grantTitle(card.grants) || "Matched grant proposal";
  const { data, error } = await supabase
    .from("intellengine_drafts")
    .insert({ client_id: clientId, card_id: cardId, title, status: "scope" })
    .select()
    .single<IntellEngineDraft>();
  if (error) {
    // Unique-violation race (a concurrent create won): return the winner's row.
    const { data: raced } = await supabase
      .from("intellengine_drafts")
      .select("*")
      .eq("card_id", cardId)
      .maybeSingle<IntellEngineDraft>();
    if (raced) return NextResponse.json({ draft: raced });
    return NextResponse.json({ error: "Couldn't start a proposal" }, { status: 500 });
  }
  return NextResponse.json({ draft: data });
}
