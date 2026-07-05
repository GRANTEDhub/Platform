import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { effectiveStage, type StoredStage } from "@/lib/leads/stage";
import { contractSignals, invoiceSignals, describeLeadEvent, type TimelineEventRow } from "@/lib/leads/events";
import { LeadControls } from "../lead-controls";
import { OutreachPanel } from "../outreach-panel";
import { SchedulingPanel } from "../scheduling-panel";
import { ContractPanel } from "../contract-panel";
import { InvoicePanel } from "../invoice-panel";
import { signedUrl, CONTRACTS_BUCKET } from "@/lib/storage";
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

  const [{ data: hookData }, { data: eventData }, { data: adminData }, { data: contractData }, { data: invoiceData }] = await Promise.all([
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
    supabase
      .from("contracts")
      .select("id, template_key, amount_cents, status, signer_name, signed_at, pdf_url")
      .eq("client_id", params.id)
      .neq("status", "void")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("invoices")
      .select("status, amount_cents, hosted_invoice_url")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false }),
  ]);

  const hooks = (hookData ?? []) as HookRow[];
  const events = (eventData ?? []) as TimelineEventRow[];
  const contractRow = ((contractData ?? []) as {
    id: string;
    template_key: string;
    amount_cents: number | null;
    status: string;
    signer_name: string | null;
    signed_at: string | null;
    pdf_url: string | null;
  }[])[0];
  // The signed PDF lives in a PRIVATE bucket; mint a short-lived signed URL for
  // the admin download link (never a public URL).
  const contractPdfUrl = contractRow?.pdf_url
    ? await signedUrl(CONTRACTS_BUCKET, contractRow.pdf_url)
    : null;
  const contract = contractRow
    ? {
        id: contractRow.id,
        templateKey: contractRow.template_key,
        amountCents: contractRow.amount_cents,
        status: contractRow.status,
        signerName: contractRow.signer_name,
        signedAt: contractRow.signed_at,
        pdfUrl: contractPdfUrl,
      }
    : null;
  const admins = ((adminData ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
    (a) => ({ id: a.id, name: a.full_name || a.email || "Unknown" }),
  );

  const bookedEvent = events.find((e) => e.event_type === "booked_call"); // events are newest-first

  // Invoices for this lead (newest first). Contract stage derives from the
  // contracts table, invoice_paid from the invoices table -- both source-of-truth,
  // never the clients mirror. Discovery-booking is a flag/badge, not a stage.
  const invoiceRows = (invoiceData ?? []) as { status: string; amount_cents: number; hosted_invoice_url: string | null }[];
  const eff = effectiveStage(lead.pipeline_stage as StoredStage, {
    ...contractSignals([contractRow?.status]),
    ...invoiceSignals(invoiceRows.map((i) => i.status)),
  });
  // The active invoice for the panel: prefer a paid one, else the most recent.
  const activeInvoice =
    invoiceRows.find((i) => i.status === "paid") ?? invoiceRows.find((i) => i.status !== "void") ?? null;
  const invoiceForPanel = activeInvoice
    ? { status: activeInvoice.status, amountCents: activeInvoice.amount_cents, hostedInvoiceUrl: activeInvoice.hosted_invoice_url }
    : null;

  // Scheduling-panel signals: the most recent scheduling-link click (cue) and the
  // current booked_call, if any (its stored meeting datetime).
  const lastClickedAt = events.find((e) => e.event_type === "clicked_schedule_call")?.occurred_at ?? null;
  const scheduledAt =
    bookedEvent && typeof bookedEvent.metadata?.scheduled_at === "string"
      ? (bookedEvent.metadata.scheduled_at as string)
      : null;
  const bookingUrl = process.env.NEXT_PUBLIC_BOOKING_URL ?? null;

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

          <Card>
            <CardHeader><CardTitle>Scheduling</CardTitle></CardHeader>
            <CardContent>
              <SchedulingPanel
                leadId={lead.id}
                bookingUrl={bookingUrl}
                lastClickedAt={lastClickedAt}
                scheduled={bookedEvent ? { at: scheduledAt } : null}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Contract</CardTitle></CardHeader>
            <CardContent>
              <ContractPanel leadId={lead.id} contract={contract} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Invoice</CardTitle></CardHeader>
            <CardContent>
              <InvoicePanel
                leadId={lead.id}
                signedContractAmountCents={contract?.status === "signed" ? contract.amountCents : null}
                invoice={invoiceForPanel}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Outreach</CardTitle></CardHeader>
            <CardContent>
              <OutreachPanel
                leadId={lead.id}
                hooks={hooks.map((h) => ({
                  id: h.id,
                  grantTitle: grantOf(h)?.title ?? "Grant",
                }))}
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
