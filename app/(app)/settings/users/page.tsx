import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canManageUsers } from "@/lib/admin/user-management";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreateUserForm } from "./create-user-form";
import type { Profile } from "@/types/database";

export const dynamic = "force-dynamic";

// Admin panel: create logins + see who exists (MVP). Double-gated: requireAdmin
// (any admin) THEN the user-admin allowlist (Shannon + Sam only). The route
// enforces the same gate independently -- this page gate is not load-bearing on
// its own.
export default async function UsersPage() {
  const profile = await requireAdmin();
  if (!canManageUsers(profile.email)) redirect("/settings");

  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, email, role, full_name")
    .order("created_at", { ascending: true });
  const users = (data ?? []) as Pick<Profile, "id" | "email" | "role" | "full_name">[];

  return (
    <div>
      <PageHeader title="Users" description="Create team logins and see who has access." />
      <div className="grid gap-6 p-8 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create user</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateUserForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Existing users</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{u.full_name || u.email}</p>
                    <p className="text-muted-foreground">{u.email}</p>
                  </div>
                  <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                </li>
              ))}
              {users.length === 0 && (
                <li className="py-6 text-center text-muted-foreground">No users yet.</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
