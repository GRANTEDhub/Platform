import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { effectiveStage, type StoredStage } from "@/lib/leads/stage";
import { signalsFromLeadRow, describeLeadEvent, type TimelineEventRow } from "@/lib/leads/events";
import { LeadControls } from "../lead-controls";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

type HookRow = {
  id: string;
  grant_id: string | null;
  fit_score: number | null;
  proposed_role: string | null;
  recommended_prime: string | null;
  concept_snapshot: string | null;
  grants: { title: string | null; source_url: string | null } | { title: string | null; source_url: string | null }[] | null;
};

function grantOf(h: HookRow) {
  const g = h.grants;
  return Array.isArray(g) ? g[0] ?? null : g;
}

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: lead } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .single<Client>();
  if (!lead || !lead.pipeline_stage) notFound(); // only leads live here

  const [{ data: hookData }, { data: eventData }, { data: adminData }] = await Promise.all([
    supabase
      .from("lead_grant_hooks")
      .select("id, grant_id, fit_score, proposed_role, recommended_prime, concept_snapshot, grants(title, source_url)")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("pipeline_events")
      .select("event_type, occurred_at, subject_snapshot, metadata")
      .eq("client_id", params.id)
      .order("occurred_at", { ascending: false }),
    supabase.from("profiles").select("id, full_name, email").eq("role", "admin").order("full_name"),
  ]);

  const hooks = (hookData ?? []) as HookRow[];
  const events = (eventData ?? []) as TimelineEventRow[];
  const admins = ((adminData ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
    (a) => ({ id: a.id, name: a.full_name || a.email || "Unknown" }),
  );

  const booked = events.some((e) => e.event_type === "booked_call");
  const eff = effectiveStage(lead.pipeline_stage as StoredStage, { ...signalsFromLeadRow(lead), booked });

  const intake = (lead.intake_data ?? {}) as Record<string, unknown>;
  const intakeEntries = Object.entries(intake).filter(([, v]) => v != null && v !== "");

  return (
    <div>
      <PageHeader
        title={lead.name}
        description={[lead.lead_source?.replace(/_/g, " "), lead.org_type?.replace(/_/g, " ")].filter(Boolean).join(" · ") || undefined}
        action={<Badge variant="secondary">{(eff ?? "—").replace(/_/g, " ")}</Badge>}
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Organization</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Location" value={[lead.location_city, lead.location_county, lead.location_state].filter(Boolean).join(", ")} />
              <Detail label="Org type" value={lead.org_type?.replace(/_/g, " ")} />
              <Detail label="Contact" value={lead.primary_contact_name} />
              <Detail label="Email" value={lead.primary_contact_email} />
              {lead.needs_review && <Detail label="Flag" value="Needs review" />}
              {lead.archived_reason && <Detail label="Archived reason" value={lead.archived_reason} />}
            </CardContent>
          </Card>

          {(lead.notes || intakeEntries.length > 0) && (
            <Card>
              <CardHeader><CardTitle>Intake &amp; notes</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {lead.notes && <p className="whitespace-pre-wrap leading-relaxed">{lead.notes}</p>}
                {intakeEntries.map(([k, v]) => (
                  <Detail key={k} label={k.replace(/_/g, " ")} value={String(v)} />
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Grant hooks ({hooks.length})</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {hooks.length === 0 ? (
                <p className="text-muted-foreground">No grant hooks.</p>
              ) : (
                hooks.map((h) => {
                  const g = grantOf(h);
                  return (
                    <div key={h.id} className="rounded-lg border border-input p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{g?.title ?? "Grant"}</p>
                        {typeof h.fit_score === "number" && <Badge variant="secondary">Fit {h.fit_score}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[h.proposed_role, h.recommended_prime ? `prime: ${h.recommended_prime}` : null].filter(Boolean).join(" · ")}
                      </p>
                      {h.concept_snapshot && <p className="mt-2 leading-relaxed">{h.concept_snapshot}</p>}
                      {g?.source_url && (
                        <a href={g.source_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-primary hover:underline">
                          source ↗
                        </a>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {events.map((e, i) => {
                    const { title, detail } = describeLeadEvent(e);
                    return (
                      <li key={i} className="flex gap-3">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                        <div className="min-w-0">
                          <p className="font-medium">
                            {title}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {format(parseISO(e.occurred_at), "MMM d, h:mma")}
                            </span>
                          </p>
                          {detail && <p className="whitespace-pre-wrap text-muted-foreground">{detail}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Manage</CardTitle></CardHeader>
            <CardContent>
              <LeadControls
                leadId={lead.id}
                currentStage={lead.pipeline_stage}
                accountManagerId={lead.account_manager_id}
                admins={admins}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{value}</p>
    </div>
  );
}
