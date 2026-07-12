import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { buildClientProfileInput, constructClientProfile } from "@/lib/clients/profile";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Stage-1 isolation test for the client refinement layer. Admin-session,
// browser-openable. Loads a real client's intake (intake_data / notes / structured
// fields), assembles the refiner input, runs constructClientProfile, and RETURNS
// both the assembled input and the distilled ClientProfile -- so a human can
// eyeball the distillation quality on real stranded free-text before anything is
// wired to matching.
//
// READ-ONLY: it does NOT write client_profile and does NOT touch the matcher. The
// null-fallback path is demonstrated too -- a refiner failure returns an error
// payload rather than 500-ing.
//
//   GET /api/clients/<clientId>/profile-preview
export async function GET(_req: Request, { params }: { params: { id: string } }) {
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
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();
  const { data: clientRow } = await db.from("clients").select("*").eq("id", params.id).single();
  if (!clientRow) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const client = clientRow as Client;
  const input = buildClientProfileInput(client);

  try {
    const clientProfile = await constructClientProfile(input);
    return NextResponse.json({
      clientId: client.id,
      name: client.name,
      input, // what actually went into the refiner -- eyeball the raw material too
      profile: clientProfile,
    });
  } catch (err) {
    // Mirror the Stage A null-fallback: a refiner failure is surfaced, not fatal.
    return NextResponse.json(
      {
        clientId: client.id,
        name: client.name,
        input,
        profile: null,
        error: String(err instanceof Error ? err.message : err).slice(0, 300),
      },
      { status: 200 },
    );
  }
}
