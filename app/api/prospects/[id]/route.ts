import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Set a prospect's contact email/name (admin) so the grant-alert one-pager can be
// emailed to them. Prospects are discovered orgs that usually have no contact
// until an admin fills one in on the review card. Writes via the service role
// after an in-route admin gate (prospects RLS is select-only).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { primary_contact_email?: string; primary_contact_name?: string };
  const email = (body.primary_contact_email ?? "").trim();
  const name = (body.primary_contact_name ?? "").trim();

  const db = createServiceClient();
  const { data, error } = await db
    .from("prospects")
    .update({ primary_contact_email: email || null, primary_contact_name: name || null })
    .eq("id", params.id)
    .select("id, primary_contact_email, primary_contact_name")
    .single();
  if (error) return NextResponse.json({ error: "Failed to update prospect" }, { status: 500 });

  return NextResponse.json({ prospect: data });
}
