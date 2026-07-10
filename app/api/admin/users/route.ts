import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canManageUsers } from "@/lib/admin/user-management";

export const runtime = "nodejs";

// In-app user-management MVP: create a login + list existing users. ADDITIVE and
// isolated -- it shares no code with the login/session path (middleware,
// lib/auth, lib/supabase/server are untouched). If this route breaks, existing
// login is unaffected (that path uses the anon key + cookies, a separate flow).
//
// Gate (defense in depth -- enforced here AND in the page): signed-in + admin +
// on the USER_ADMIN_ALLOWLIST. Identity comes from the session, never from input.
//
// Create flow mirrors a dashboard-created user exactly:
//   1. auth.admin.createUser (service key) with email_confirm:true -> the
//      on_auth_user_created trigger auto-creates the profiles row (role defaults
//      to 'contractor').
//   2. If admin was requested, set the role via the ACTING ADMIN's session client
//      so profiles_update RLS and guard_role_change both validate (is_admin()).

const ROLES = ["contractor", "admin"] as const;
type Role = (typeof ROLES)[number];

async function authorize() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, email")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin" || !canManageUsers(profile.email)) {
    return { error: NextResponse.json({ error: "Not authorized to manage users" }, { status: 403 }) };
  }
  return { supabase };
}

export async function GET() {
  const auth = await authorize();
  if ("error" in auth) return auth.error;
  const { supabase } = auth;
  // profiles_select lets an admin read all rows.
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role, full_name, created_at")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authorize();
  if ("error" in auth) return auth.error;
  const { supabase } = auth;

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    role?: string;
    full_name?: string;
  };
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  const role = (body.role ?? "contractor") as Role;
  const full_name = body.full_name?.trim() || undefined;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Temp password must be at least 8 characters" }, { status: 400 });
  }
  if (!ROLES.includes(role)) {
    return NextResponse.json({ error: "Role must be 'contractor' or 'admin'" }, { status: 400 });
  }

  // Step 1: create the auth user (service key). email_confirm so they can sign in
  // immediately with no SMTP. The trigger creates the profiles row as contractor.
  const admin = createServiceClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: full_name ? { full_name } : undefined,
  });
  if (createErr || !created?.user) {
    return NextResponse.json(
      { error: `Could not create user: ${createErr?.message ?? "unknown error"}` },
      { status: 400 },
    );
  }
  const newId = created.user.id;

  // Step 2: apply the role only when admin was requested. Use the ACTING ADMIN's
  // session client so profiles_update (USING id=auth.uid() OR is_admin) and
  // guard_role_change (permitted when the caller is_admin) both pass. Contractor
  // needs no write -- the trigger default already set it.
  if (role === "admin") {
    const { data: updated, error: roleErr } = await supabase
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", newId)
      .select("id")
      .maybeSingle();
    if (roleErr || !updated) {
      // The auth user + profile exist (as contractor). Report it rather than
      // silently mis-provisioning; the row can be promoted from the dashboard.
      return NextResponse.json({
        ok: true,
        id: newId,
        email,
        role: "contractor",
        warning: `User created, but the role could not be set to admin${roleErr ? `: ${roleErr.message}` : ""}. They exist as contractor.`,
      });
    }
  }

  return NextResponse.json({ ok: true, id: newId, email, role });
}
