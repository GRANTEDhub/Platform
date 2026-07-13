import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { effectiveStage, type StoredStage, type EffectiveStage } from "@/lib/leads/stage";
import { contractSignals, invoiceSignals, intakeStatus, describeLeadEvent, type IntakeStatus, type TimelineEventRow } from "@/lib/leads/events";
import { OutreachPanel } from "../outreach-panel";
import { SchedulingPanel } from "../scheduling-panel";
import { ContractPanel } from "../contract-panel";
import { InvoicePanel } from "../invoice-panel";
import { ConvertButton } from "../convert-button";
import { StageProgress } from "../stage-progress";
import { ContactEmailField } from "../contact-email-field";
import { NoteField } from "../note-field";
import { FooterActions } from "../footer-actions";
import { ReactivateButton } from "../reactivate-button";
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

const INTAKE_BADGE: Record<IntakeStatus, { label: string; variant: "success" | "secondary" | "outline" }> = {
  received: { label: "Intake received", variant: "success" },
  sent: { label: "Intake sent", variant: "outline" },
  not_sent: { label: "No intake", variant: "secondary" },
};

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: lead } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
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
    id: string; template_key: string; amount_cents: number | null; status: string; signer_name: string | null; signed_at: string | null; pdf_url: string | null;
  }[])[0];
  const contractPdfUrl = contractRow?.pdf_url ? await signedUrl(CONTRACTS_BUCKET, contractRow.pdf_url) : null;
  const contract = contractRow
    ? { id: contractRow.id, templateKey: contractRow.template_key, amountCents: contractRow.amount_cents, status: contractRow.status, signerName: contractRow.signer_name, signedAt: contractRow.signed_at, pdfUrl: contractPdfUrl }
    : null;
  const admins = ((adminData ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
    (a) => ({ id: a.id, name: a.full_name || a.email || "Unknown" }),
  );

  const bookedEvent = events.find((e) => e.event_type === "booked_call");
  const invoiceRows = (invoiceData ?? []) as { status: string; amount_cents: number; hosted_invoice_url: string | null }[];
  const eff = effectiveStage(lead.pipeline_stage as StoredStage, {
    ...contractSignals([contractRow?.status]),
    ...invoiceSignals(invoiceRows.map((i) => i.status)),
  });
  const activeInvoice = invoiceRows.find((i) => i.status === "paid") ?? invoiceRows.find((i) => i.status !== "void") ?? null;
  const invoiceForPanel = activeInvoice
    ? { status: activeInvoice.status, amountCents: activeInvoice.amount_cents, hostedInvoiceUrl: activeInvoice.hosted_invoice_url }
    : null;

  const inviteSentAt = events.find((e) => e.event_type === "discovery_invite_sent")?.occurred_at ?? null;
  const lastClickedAt = events.find((e) => e.event_type === "clicked_schedule_call")?.occurred_at ?? null;
  const scheduledAt = bookedEvent && typeof bookedEvent.metadata?.scheduled_at === "string" ? (bookedEvent.metadata.scheduled_at as string) : null;
  const bookingUrl = process.env.NEXT_PUBLIC_BOOKING_URL ?? null;
  const booked = !!bookedEvent || !!lead.discovery_booked_at;

  const intake = (lead.intake_data ?? {}) as Record<string, unknown>;
  const intakeEntries = Object.entries(intake).filter(([, v]) => v != null && v !== "");
  const intakeStat = intakeStatus(lead);
  const owner = lead.account_manager_id
    ? admins.find((a) => a.id === lead.account_manager_id)?.name ?? "Assigned"
    : "Unassigned";

  // The single current step that drives the Next-step card.
  const converted = lead.pipeline_stage === "converted";
  const terminal = eff === "rejected" || eff === "archived";
  const currentStep: "schedule" | "contract" | "invoice" | "convert" | "converted" | "terminal" = converted
    ? "converted"
    : terminal
      ? "terminal"
      : eff === "invoice_paid"
        ? "convert"
        : eff === "contract_signed"
          ? "invoice"
          : eff === "contract_pending"
            ? "contract"
            : booked
              ? "contract" // discovery_pending + booked -> generate/send the contract
              : "schedule";

  // The three workflow panels; the current one is promoted to the Next-step card,
  // the rest go into the "Other pipeline steps" accordion (each renders once).
  const schedulingNode = (
    <SchedulingPanel leadId={lead.id} bookingUrl={bookingUrl} inviteSentAt={inviteSentAt} lastClickedAt={lastClickedAt} scheduled={bookedEvent ? { at: scheduledAt } : null} />
  );
  const contractNode = <ContractPanel leadId={lead.id} contract={contract} />;
  const invoiceNode = (
    <InvoicePanel leadId={lead.id} signedContractAmountCents={contract?.status === "signed" ? contract.amountCents : null} invoice={invoiceForPanel} />
  );
  const stepPanels = [
    { key: "schedule", title: "Discovery scheduling", node: schedulingNode },
    { key: "contract", title: "Contract", node: contractNode },
    { key: "invoice", title: "Invoice", node: invoiceNode },
  ];
  const otherSteps = stepPanels.filter((s) => s.key !== currentStep);

  const nextStep = (() => {
    switch (currentStep) {
      case "schedule": return { context: "Get them on a discovery call.", node: schedulingNode };
      case "contract": return { context: booked ? "Discovery booked — send the engagement contract." : "Send the engagement contract.", node: contractNode };
      case "invoice": return { context: "Contract signed — issue the invoice and collect payment.", node: invoiceNode };
      case "convert": return { context: "Paid in full — convert to an active client.", node: <ConvertButton leadId={lead.id} canConvert alreadyConverted={false} /> };
      case "converted": return { context: "This lead has converted to an active client.", node: <ConvertButton leadId={lead.id} canConvert={false} alreadyConverted /> };
      case "terminal": return {
        context: eff === "rejected" ? "This lead was rejected." : "This lead is archived.",
        node: (
          <div className="space-y-3 text-sm">
            {lead.archived_reason && <p className="text-muted-foreground">Reason: {lead.archived_reason}</p>}
            <ReactivateButton leadId={lead.id} />
          </div>
        ),
      };
    }
  })();

  return (
    <div className="min-h-full bg-brand-cream">
      <PageHeader
        title={lead.name}
        description={[lead.lead_source?.replace(/_/g, " "), lead.org_type?.replace(/_/g, " "), [lead.location_city, lead.location_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex items-center gap-3 text-sm">
            {/* Bridge to the match dashboard (/clients/[id]). A lead/prospect lives
                under /leads but its one-time-match results render on the client
                dashboard, which is otherwise only reachable by URL. Text label +
                arrow, not color alone (accessibility). */}
            <Link href={`/clients/${lead.id}`} className="font-medium text-primary hover:underline">
              View matches →
            </Link>
            <Badge variant="secondary">{(eff ?? "—").replace(/_/g, " ")}</Badge>
            <span className="text-muted-foreground">{owner}</span>
          </div>
        }
      />

      <div className="mx-auto max-w-4xl space-y-6 p-8">
        {/* Progress */}
        <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-5">
          <StageProgress eff={eff} />
        </div>

        {/* Next step — the centerpiece */}
        <div className="rounded-2xl border border-brand-orange/30 bg-white p-6 shadow-[0_2px_10px_rgba(179,84,30,0.06)]">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-orange">Next step</p>
          <h2 className="mt-1 font-serif text-lg font-semibold text-brand-navy">{nextStep?.context}</h2>
          <div className="mt-4">{nextStep?.node}</div>
        </div>

        {/* Quick facts */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Contact</p>
            <p className="mt-1 font-medium text-brand-navy">{lead.primary_contact_name || "—"}</p>
            <div className="mt-2">
              <ContactEmailField leadId={lead.id} currentEmail={lead.primary_contact_email} />
            </div>
          </div>
          <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Intake</p>
            <div className="mt-2 flex items-center gap-2">
              <Badge variant={INTAKE_BADGE[intakeStat].variant}>{INTAKE_BADGE[intakeStat].label}</Badge>
              {lead.needs_review && <Badge variant="warning">Needs review</Badge>}
            </div>
            {lead.intake_sent_at && intakeStat === "sent" && (
              <p className="mt-2 text-xs text-muted-foreground">Sent {format(parseISO(lead.intake_sent_at), "MMM d, yyyy")}</p>
            )}
          </div>
        </div>

        {/* Depth — collapsed accordions */}
        <div className="overflow-hidden rounded-2xl border border-brand-navy/[0.08] bg-white">
          {otherSteps.length > 0 && (
            <Accordion title="Other pipeline steps">
              <div className="space-y-5">
                {otherSteps.map((s) => (
                  <div key={s.key}>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.title}</p>
                    {s.node}
                  </div>
                ))}
              </div>
            </Accordion>
          )}

          <Accordion title="Grant hooks" count={hooks.length}>
            {hooks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No grant hooks.</p>
            ) : (
              <div className="space-y-3 text-sm">
                {hooks.map((h) => {
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
                })}
              </div>
            )}
          </Accordion>

          <Accordion title="Outreach & notes">
            <div className="space-y-5">
              <NoteField leadId={lead.id} />
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Draft outreach</p>
                <OutreachPanel leadId={lead.id} hooks={hooks.map((h) => ({ id: h.id, grantTitle: grantOf(h)?.title ?? "Grant" }))} />
              </div>
            </div>
          </Accordion>

          {intakeEntries.length > 0 && (
            <Accordion title="Intake responses" count={intakeEntries.length}>
              <div className="space-y-3 text-sm">
                {intakeEntries.map(([k, v]) => (
                  <div key={k}>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{k.replace(/_/g, " ")}</p>
                    <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{String(v)}</p>
                  </div>
                ))}
              </div>
            </Accordion>
          )}

          <Accordion title="Full timeline" count={events.length} last>
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
                          <span className="ml-2 text-xs font-normal text-muted-foreground">{format(parseISO(e.occurred_at), "MMM d, h:mma")}</span>
                        </p>
                        {detail && <p className="whitespace-pre-wrap text-muted-foreground">{detail}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Accordion>
        </div>

        {/* De-emphasized footer */}
        <FooterActions leadId={lead.id} admins={admins} accountManagerId={lead.account_manager_id} isTerminal={terminal || converted} />
      </div>
    </div>
  );
}

// Native <details> accordion row, collapsed by default, hairline-divided.
function Accordion({ title, count, last, children }: { title: string; count?: number; last?: boolean; children: React.ReactNode }) {
  return (
    <details className={`group ${last ? "" : "border-b border-brand-navy/[0.08]"}`}>
      <summary className="flex cursor-pointer items-center justify-between px-5 py-4 text-sm font-medium text-brand-navy [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          {title}
          {typeof count === "number" && (
            <span className="rounded-full bg-brand-navy/[0.06] px-2 py-0.5 text-xs font-normal text-muted-foreground">{count}</span>
          )}
        </span>
        <span className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
