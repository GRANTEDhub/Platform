import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canManageUsers } from "@/lib/admin/user-management";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Profile } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const profile = await requireAdmin();
  const supabase = createClient();
  const { data } = await supabase.from("profiles").select("*").order("created_at");
  const team = (data ?? []) as Profile[];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Team members and their access level."
        action={
          canManageUsers(profile.email) ? (
            <Link
              href="/settings/users"
              className="text-sm font-medium text-brand-navy underline underline-offset-4"
            >
              Manage users →
            </Link>
          ) : undefined
        }
      />
      <div className="p-8">
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {team.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{p.full_name || p.email}</p>
                    <p className="text-muted-foreground">{p.email}</p>
                  </div>
                  <Badge variant={p.role === "admin" ? "default" : "secondary"}>
                    {p.role}
                  </Badge>
                </li>
              ))}
              {team.length === 0 && (
                <li className="py-6 text-center text-muted-foreground">
                  No team members loaded.
                </li>
              )}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">
              Roles are managed in Supabase for now (profiles.role). In-app role
              management ships with the settings phase.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
