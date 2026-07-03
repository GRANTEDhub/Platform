import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { lookupByUei, searchByNameState, isValidUei, SamError } from "@/lib/sam/client";
import type { Client } from "@/types/database";

// Admin-only SAM.gov resolve. Returns candidate registrations; STORES NOTHING --
// binding happens only after the human confirms (see ./bind). Two paths:
//   { uei }        -> direct lookup, returns the single match (or none)
//   {} (no uei)    -> name + state best-guess, returns up to 4 candidates
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const db = createServiceClient();
  const { data: client } = await db
    .from("clients")
    .select("name, location_state, location_city")
    .eq("id", params.id)
    .single<Pick<Client, "name" | "location_state" | "location_city">>();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { uei?: string };

  try {
    if (body.uei) {
      if (!isValidUei(body.uei)) {
        return NextResponse.json(
          { error: "A UEI is 12 letters/numbers (no I or O)." },
          { status: 400 },
        );
      }
      const match = await lookupByUei(body.uei);
      return NextResponse.json({ candidates: match ? [match] : [] });
    }
    const candidates = await searchByNameState(
      client.name,
      client.location_state,
      client.location_city,
    );
    return NextResponse.json({ candidates });
  } catch (err) {
    if (err instanceof SamError) {
      const status = err.code === "rate_limit" ? 429 : err.code === "bad_request" ? 400 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: "SAM lookup failed." }, { status: 502 });
  }
}
