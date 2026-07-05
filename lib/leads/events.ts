import { format, parseISO } from "date-fns";
import type { LeadSignals } from "./stage";

// Best-effort human date for a stored meeting datetime. The value may be a naive
// datetime-local string ("2026-07-10T14:00"); if it won't parse we show it raw.
function fmtScheduled(v: string): string {
  try {
    return format(parseISO(v), "MMM d, h:mma");
  } catch {
    return v;
  }
}

// Human labels for the pipeline_events types that show on a lead timeline.
// Unknown types fall back to a humanized form of the raw string, so a new event
// type never renders as a blank row.
const LABELS: Record<string, string> = {
  lead_created: "Lead created",
  hook_attached: "Grant hook added",
  routed_to_client: "Routed to client",
  clicked_schedule_call: "Clicked scheduling link",
  booked_call: "Booked a call",
  stage_change: "Stage changed",
  note: "Note",
  am_assigned: "Account manager assigned",
  outreach_sent: "Outreach sent",
  contract_sent: "Contract sent for signature",
  contract_signed: "Contract signed",
  invoice_sent: "Invoice issued",
  invoice_paid: "Invoice paid",
};

export interface TimelineEventRow {
  event_type: string;
  occurred_at: string;
  subject_snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

// Render one timeline event as a title + optional detail line. Pure; the page
// maps events through it.
export function describeLeadEvent(e: TimelineEventRow): { title: string; detail: string | null } {
  const title =
    LABELS[e.event_type] ?? e.event_type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const m = e.metadata ?? {};
  switch (e.event_type) {
    case "stage_change": {
      const from = typeof m.from === "string" ? m.from : "?";
      const to = typeof m.to === "string" ? m.to : "?";
      const reason = typeof m.reason === "string" && m.reason ? ` — ${m.reason}` : "";
      return { title, detail: `${from} → ${to}${reason}` };
    }
    case "note":
      return { title, detail: typeof m.note === "string" ? m.note : null };
    case "am_assigned":
      return { title, detail: typeof m.name === "string" ? m.name : null };
    case "booked_call": {
      const when = typeof m.scheduled_at === "string" && m.scheduled_at ? m.scheduled_at : null;
      return { title, detail: when ? `call on ${fmtScheduled(when)}` : null };
    }
    case "contract_sent": {
      const amt = typeof m.amount_cents === "number" ? `$${(m.amount_cents / 100).toLocaleString("en-US")}` : null;
      const tmpl = typeof m.template_key === "string" ? m.template_key.replace(/_/g, " ") : null;
      return { title, detail: [tmpl, amt].filter(Boolean).join(" · ") || null };
    }
    case "contract_signed":
      return { title, detail: typeof m.signed_at === "string" ? fmtScheduled(m.signed_at) : null };
    case "invoice_sent":
    case "invoice_paid": {
      const amt = typeof m.amount_cents === "number" ? `$${(m.amount_cents / 100).toLocaleString("en-US")}` : null;
      return { title, detail: amt };
    }
    case "outreach_sent": {
      const to = typeof m.to === "string" ? `to ${m.to}` : null;
      const grant = typeof m.grant_title === "string" ? `re: ${m.grant_title}` : null;
      return { title, detail: [to, grant].filter(Boolean).join(" · ") || null };
    }
    case "lead_created":
    case "hook_attached":
    case "routed_to_client": {
      const role = typeof m.proposed_role === "string" ? m.proposed_role : null;
      const fit = typeof m.fit_score === "number" ? `fit ${m.fit_score}` : null;
      return { title, detail: [role, fit].filter(Boolean).join(" · ") || null };
    }
    default:
      return { title, detail: null };
  }
}

// Contract-derived signals, computed from the contracts table (source of truth),
// NOT the clients mirror. Pass the lead's non-void contract statuses; a signed
// contract wins (contract_signed), else any draft/sent contract is pending
// (contract_pending). Callers batch-load contracts for the list, or read the
// lead's active contract on the detail page.
export function contractSignals(statuses: (string | null | undefined)[]): LeadSignals {
  const signed = statuses.some((s) => s === "signed");
  const pending = !signed && statuses.some((s) => s === "draft" || s === "sent");
  return { contractSigned: signed, contractPending: pending };
}

// Payment-derived signal, computed from the invoices table (source of truth), the
// parallel of contractSignals. A paid invoice lights the invoice_paid stage. Dark
// until P5 issues invoices, but wired now so the stage card is real.
export function invoiceSignals(statuses: (string | null | undefined)[]): LeadSignals {
  return { invoicePaid: statuses.some((s) => s === "paid") };
}

// Intake badge (a FLAG, never a stage): 'received' if intake answers are on file,
// else 'sent' if an intake form was sent, else 'not_sent'. Derived from
// intake_data + intake_sent_at.
export type IntakeStatus = "not_sent" | "sent" | "received";
export function intakeStatus(row: {
  intake_data: Record<string, unknown> | null;
  intake_sent_at: string | null;
}): IntakeStatus {
  if (row.intake_data && Object.keys(row.intake_data).length > 0) return "received";
  if (row.intake_sent_at) return "sent";
  return "not_sent";
}

// The stored stages an admin may hand-set: the entry stage + the two off-ladder
// side states. Derived stages (contract_*, invoice_paid) and the terminal
// 'converted' (reached only by the convert action) are excluded.
export const SETTABLE_STAGES = [
  "discovery_pending",
  "rejected",
  "archived",
] as const;
export type SettableStage = (typeof SETTABLE_STAGES)[number];
