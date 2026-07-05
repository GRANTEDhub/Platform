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

// Signals derivable from the lead's own clients row (cheap enough for the list).
// The event-derived signal (booked_call) is added on the detail page where we
// already load the timeline. Everything absent until P3-P5 simply stays false,
// so effectiveStage() returns the stored human stage today.
export function signalsFromLeadRow(row: {
  contract_status: string | null;
  contract_signed_at: string | null;
}): LeadSignals {
  return {
    contractStarted: !!row.contract_status,
    contractSigned: !!row.contract_signed_at,
  };
}

// The stored human stages an admin may hand-set (excludes derived stages and the
// terminal 'converted', which only the convert action reaches).
export const SETTABLE_STAGES = [
  "outbound_new",
  "new",
  "contacted",
  "quoted",
  "pending",
  "archived",
] as const;
export type SettableStage = (typeof SETTABLE_STAGES)[number];
