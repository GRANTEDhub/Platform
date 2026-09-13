import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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
export async function GET() {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("client_overview")
    .select("id, name, pipeline_stage")
    .order("name");
  if (error) {
    return NextResponse.json({ error: "Could not load the client roster." }, { status: 500 });
  }

  const clients = (data ?? [])
    .filter(
      (c): c is { id: string; name: string; pipeline_stage: string | null } =>
        !!c && typeof c.id === "string" && typeof c.name === "string" && c.name.length > 0,
    )
    // Match the Portfolio list's visibility exactly (app/(app)/clients/page.tsx): drop archived /
    // rejected clients (dead relationships) so the picker doesn't offer a target that is excluded
    // everywhere else. Null stage passes, mirroring Portfolio's `!== archived && !== rejected`.
    .filter((c) => c.pipeline_stage !== "archived" && c.pipeline_stage !== "rejected")
    .map((c) => ({ id: c.id, name: c.name }));

  return NextResponse.json({ clients });
}
