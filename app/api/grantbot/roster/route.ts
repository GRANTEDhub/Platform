import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { pickRosterClients } from "@/lib/grantbot/switcher";

// The roster the Switcher's target picker lists: {id, name} for every client the acting staffer can
// see, ordered by name. Lightweight (two columns), fetched ONCE when the picker first opens.
//
// STAFF-ONLY and RLS-SCOPED — the two things that keep it safe:
//   • getProfile() is null for a client-portal member (no profiles row), so this is the same staff
//     gate as the turn/context routes (401, not a redirect, so a fetch gets a JSON error).
//   • It reads client_overview through the SESSION client (createClient), NOT the service role, so
//     RLS scopes it to exactly the clients this actor can see — a contractor gets only their assigned
//     clients, the SAME visibility as their Portfolio list, by construction. (The per-client turn/
//     context routes still run service-role and gate the client boundary in code; the picker is a
//     discovery surface, so it wants the RLS view of "which clients are mine".)
//
// `?include=<clientId>` keeps that ONE client in the roster even if it is archived/rejected — the
// Switcher passes the id of the dashboard it is currently on, so it can resolve that client's name
// and host its bot on its own dashboard even though the dead-relationship filter would otherwise drop
// it. Still RLS-scoped: `include` can only ever re-admit a client this actor may already see
// (pickRosterClients only re-admits an id that survived the RLS read).
export async function GET(req: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const include = new URL(req.url).searchParams.get("include");

  const supabase = createClient();
  const { data, error } = await supabase
    .from("client_overview")
    .select("id, name, pipeline_stage")
    .order("name");
  if (error) {
    return NextResponse.json({ error: "Could not load the client roster." }, { status: 500 });
  }

  return NextResponse.json({ clients: pickRosterClients(data ?? [], include) });
}
