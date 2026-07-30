import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveEinCandidates, normalizeEin } from "@/lib/grants/propublica";
import { refreshClientNonprofitFinanceById } from "@/lib/clients/nonprofit-finance-refresh";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// EIN resolve + bind, deliberately shaped like the existing SAM.gov resolve/bind
// pair: the same org-identity problem gets the same answer, so there is one pattern
// to understand rather than two.
//
//   GET  -> ranked candidates (name + city + state evidence). Stores NOTHING.
//   POST -> bind a chosen EIN, then pull the 990 for it and return the result.
//
// Candidates are computed on demand rather than cached, which is why this needs no
// migration: the shortlist is cheap, and a stored shortlist would go stale against
// the client's own address the moment someone edits it.

async function requireStaff() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile) return { error: NextResponse.json({ error: "Staff only" }, { status: 403 }) };
  return { error: null as null };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff();
  if (gate.error) return gate.error;

  const db = createServiceClient();
  const { data } = await db
    .from("clients")
    .select("id, name, location_city, location_state, ein")
    .eq("id", params.id)
    .single();
  if (!data) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const client = data as Pick<Client, "id" | "name" | "location_city" | "location_state" | "ein">;
  const { candidates, autoBind } = await resolveEinCandidates({
    name: client.name,
    city: client.location_city,
    state: client.location_state,
  });

  return NextResponse.json({
    current: client.ein ?? null,
    candidates,
    // Reported so the UI can say "we filled this in for you" rather than leaving the
    // reviewer to wonder whether they chose it.
    autoBindable: autoBind?.ein ?? null,
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff();
  if (gate.error) return gate.error;

  let body: { ein?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with an ein." }, { status: 400 });
  }

  // A hand-typed EIN goes through the same normalizer as a picked candidate, so
  // "71-0236875" and "710236875" cannot diverge into two different stored forms.
  const ein = normalizeEin(typeof body.ein === "string" ? body.ein : null);
  if (!ein) {
    return NextResponse.json({ error: "That EIN isn't 9 digits." }, { status: 400 });
  }

  const db = createServiceClient();
  const { error } = await db.from("clients").update({ ein }).eq("id", params.id);
  if (error) return NextResponse.json({ error: "Couldn't save the EIN." }, { status: 500 });

  // Pull the 990 immediately with the new key -- awaited, so the caller learns
  // whether the EIN actually resolves to filings instead of being told "saved" and
  // discovering days later that it matched nothing.
  const pulled = await refreshClientNonprofitFinanceById(db, params.id);

  const { data: after } = await db
    .from("clients")
    .select("ein, nonprofit_finance, nonprofit_finance_checked_at")
    .eq("id", params.id)
    .single();

  return NextResponse.json({
    ein,
    pulled,
    finance: (after as Pick<Client, "nonprofit_finance"> | null)?.nonprofit_finance ?? null,
  });
}
