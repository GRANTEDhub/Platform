import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  await requireAdmin();
  const supabase = createClient();
  const { data } = await supabase.from("clients").select("*").order("name");
  const clients = (data ?? []) as Client[];

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Your active roster and prospects."
        action={
          <Link href="/clients/new">
            <Button>Add client</Button>
          </Link>
        }
      />
      <div className="p-8">
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">
                    {c.org_type?.replace(/_/g, " ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {[c.location_city, c.location_state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary">{c.status}</Badge>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    No clients yet. Add your first client to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
