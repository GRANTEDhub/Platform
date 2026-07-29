"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChipInput } from "@/components/ui/chip-input";
import { NarrativeFields } from "@/components/intake/narrative-fields";
import { narrativeFromClient } from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { ORG_TYPES } from "@/lib/clients/org-types";
import type { Client } from "@/types/database";

// Client-only statuses. Prospect/lead state is written server-side
// (status='lead' + pipeline_stage='discovery_pending'), never chosen here.
const CLIENT_STATUSES = ["active", "paused", "closed"];

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue ?? undefined}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * The single create/edit form for a client OR a prospect. There is no record-type
 * toggle: `kind` comes from the entry point (defaultKind on create) or is derived
 * from the row on edit (an un-converted lead is a prospect). Both kinds share the
 * same opening — website, org, contact, location, narrative — and the client-only
 * sections (engagement, grant-matching profile, matcher note) render only for a
 * client. The server action (actions.ts) stays authoritative for the prospect-safe
 * write (status='lead', pipeline_stage='discovery_pending', account_managed=false).
 *
 * Fields dropped from the UI in the redesign (next step, internal notes, project
 * stage, hard constraints, advisory constraints) are carried as hidden passthroughs
 * so the decluttered form never NULLs a stored value on save — parse() writes every
 * column it reads, so an absent field would otherwise wipe it (incl. matcher gates).
 */
export function ClientForm({
  client,
  action,
  submitLabel,
  defaultKind,
}: {
  client?: Client;
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  submitLabel: string;
  // The record type for a NEW record, set by the entry point (/clients/new →
  // "client", /intel/prospects/new → "prospect"). Ignored on edit (derived below).
  defaultKind?: "client" | "prospect";
}) {
  // No toggle: kind is fixed for the life of the form. New → defaultKind (default
  // "client"); edit → derived from the stored row.
  const kind: "client" | "prospect" = !client
    ? defaultKind ?? "client"
    : isUnconvertedLead(client.pipeline_stage)
      ? "prospect"
      : "client";
  const isClient = kind === "client";

  // Org type is controlled so the research-grants opt-in can show/hide reactively.
  const [orgType, setOrgType] = useState(client?.org_type ?? "");
  const showResearchOptIn = orgType === "small_business" || orgType === "higher_education";
  // Controlled so the narrative's "Draft from website" button sees the live URL.
  const [website, setWebsite] = useState(client?.website ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(formData: FormData) {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    const result = await action(formData);
    // A successful create/update redirects and unmounts this form, so we reach here
    // only on an expected validation failure: show it and re-enable to retry.
    if (result?.error) {
      setFormError(result.error);
      setSubmitting(false);
    }
  }

  const kindLabel = isClient ? "client" : "prospect";

  return (
    <form action={handleSubmit} className="max-w-3xl space-y-8">
      {/* Record type is fixed by the entry point (no toggle) and written server-side. */}
      <input type="hidden" name="kind" value={kind} />

      <p className="text-sm text-muted-foreground">
        {client ? `Editing ${kindLabel}` : `New ${kindLabel}`}
        {!isClient && " — staff-only, no client login, no daily matching (matched on demand)."}
      </p>

      {/* 1. Website — the opening. The profile can be drafted from the site via the
          "Draft from website" button in the narrative section below. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Website</h2>
        <Input
          id="website"
          name="website"
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://…"
        />
        <p className="text-xs text-muted-foreground">
          Start here — with a URL, use <span className="font-medium">Draft from website</span> under
          the narrative to prefill from the site. Everything stays editable.
        </p>
      </section>

      {/* 2. Organization. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Organization</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="name" defaultValue={client?.name} />
          <div className="space-y-2">
            <Label htmlFor="org_type">Org type</Label>
            <select
              id="org_type"
              name="org_type"
              value={orgType}
              onChange={(e) => setOrgType(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              <option value="">—</option>
              {ORG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Research-grants opt-in — clients only, and only for the org types with a
            plausible research-applicant case. Default OFF (GRANTED excludes research
            funders from matching + the horizon). An unchecked/hidden box → false. */}
        {isClient && showResearchOptIn && (
          <label className="flex items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              name="research_opt_in"
              value="true"
              defaultChecked={!!client?.research_opt_in}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Include research grants for this client</span>
              <span className="block text-xs text-muted-foreground">
                Off by default. GRANTED excludes research funders (e.g. NIH) from matching and the
                forecast horizon. Check this only if this organization pursues federal research grants.
              </span>
            </span>
          </label>
        )}
      </section>

      {/* 3. Primary contact. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Primary contact</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="primary_contact_name" defaultValue={client?.primary_contact_name} />
          <Field label="Email" name="primary_contact_email" type="email" defaultValue={client?.primary_contact_email} />
          {isClient && (
            <Field label="Phone" name="primary_contact_phone" defaultValue={client?.primary_contact_phone} />
          )}
        </div>
      </section>

      {/* 4. Location. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Location</h2>
        <Field
          label="Street address"
          name="location_street"
          defaultValue={client?.location_street}
          placeholder="e.g. 500 W Markham St (enables tract-level need + eligibility data)"
        />
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="City" name="location_city" defaultValue={client?.location_city} />
          <Field label="County" name="location_county" defaultValue={client?.location_county} />
          <Field label="State" name="location_state" defaultValue={client?.location_state ?? "AR"} />
          <Field label="ZIP" name="location_zip" defaultValue={client?.location_zip} />
        </div>
      </section>

      {/* 5. Narrative — the matching-relevant signal. Prospects get the light set
          (intent + mission + priority areas); clients get the full set. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Narrative</h2>
        <p className="text-xs text-muted-foreground">
          Feeds the profile (enrichment) and grounds matching. Not used for seat/eligibility scoring.
        </p>
        <NarrativeFields
          defaultValue={client ? narrativeFromClient(client) : undefined}
          websiteForDraft={website}
          variant={isClient ? "full" : "light"}
        />
      </section>

      {/* 6. Engagement — CLIENTS ONLY. */}
      {isClient && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Engagement <span className="font-normal normal-case text-muted-foreground">(optional)</span>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                name="status"
                defaultValue={client?.status && CLIENT_STATUSES.includes(client.status) ? client.status : "active"}
                className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              >
                {CLIENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Engagement tier" name="engagement_tier" defaultValue={client?.engagement_tier} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Retainer hours" name="retainer_hours" type="number" defaultValue={client?.retainer_hours} />
            <Field label="Contract start" name="contract_start" type="date" defaultValue={client?.contract_start} />
            <Field label="Contract end" name="contract_end" type="date" defaultValue={client?.contract_end} />
          </div>
          {/* Account-managed (migration 0059): premium gate. When checked, an account
              manager reviews + releases each match before the client sees it. */}
          <label className="flex items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              name="account_managed"
              value="true"
              defaultChecked={!!client?.account_managed}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Account-managed (premium)</span>
              <span className="block text-xs text-muted-foreground">
                An account manager reviews and releases each match before the client sees it. Off by
                default — the client goes straight to their own Grant Alerts / Grant Report.
              </span>
            </span>
          </label>
        </section>
      )}

      {/* 7. Grant-matching profile — CLIENTS ONLY, optional. Recorded data the matcher
          reads; project stage dropped from the UI (preserved via passthrough below). */}
      {isClient && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Grant-matching profile{" "}
            <span className="font-normal normal-case text-muted-foreground">(optional)</span>
          </h2>
          <p className="text-xs text-muted-foreground">Recorded for matching context. Not financial data — visible to contractors.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Match / cost-share capacity" name="match_cost_share_capacity" defaultValue={client?.match_cost_share_capacity} />
            <Field label="Annual budget" name="annual_budget" defaultValue={client?.annual_budget} />
            <Field label="RUCC codes" name="rucc_codes" defaultValue={client?.rucc_codes} />
            <Field label="IRS EIN" name="ein" defaultValue={client?.ein} placeholder="e.g. 71-0236875 — pulls annual budget from the IRS 990" />
          </div>
          {/* Sourced budget citation from the org's latest IRS 990 (ProPublica),
              pulled in the background after an EIN is saved. A flag/citation, never a
              matcher gate. */}
          {client?.nonprofit_finance?.verified && client.nonprofit_finance.total_revenue != null && (
            <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Latest IRS 990</span>
              {client.nonprofit_finance.fiscal_year ? ` (FY${client.nonprofit_finance.fiscal_year})` : ""}: total revenue{" "}
              ${client.nonprofit_finance.total_revenue.toLocaleString("en-US")}
              {client.nonprofit_finance.total_expenses != null &&
                `, expenses $${client.nonprofit_finance.total_expenses.toLocaleString("en-US")}`}
              {" "}— pulled from ProPublica. Citation only; not used to gate matching.
            </p>
          )}
          <ChipInput
            name="service_area"
            label="Service area"
            defaultValue={client?.service_area ?? undefined}
            placeholder="Type a county or region, press Enter"
          />
        </section>
      )}

      {/* 8. Note to the matcher — CLIENTS ONLY. The single retained matcher control
          (the hard-constraint picker + advisory box are preserved via passthrough). */}
      {isClient && (
        <section className="space-y-2">
          <Label htmlFor="matching_rules">Note to the matcher (optional)</Label>
          <textarea
            id="matching_rules"
            name="matching_rules"
            defaultValue={client?.matching_rules ?? undefined}
            rows={4}
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            placeholder={'Authoritative guidance the model applies. e.g. "Only pursue rural health grants." / "Never recommend as prime on research-heavy programs."'}
          />
          <p className="text-xs text-muted-foreground">Read by the model as authoritative guidance for this client.</p>
        </section>
      )}

      {/* Preserved-but-hidden: dropped from the UI in the redesign but NOT wiped —
          parse() writes every column it reads, so an absent field would null the
          stored value (incl. code-enforced matcher gates). Pass the stored value
          through so a save leaves them untouched. Empty on create (new record). */}
      <input type="hidden" name="next_step" value={client?.next_step ?? ""} readOnly />
      <input type="hidden" name="notes" value={client?.notes ?? ""} readOnly />
      <input type="hidden" name="project_stage" value={client?.project_stage ?? ""} readOnly />
      <input type="hidden" name="hard_constraints" value={JSON.stringify(client?.hard_constraints ?? [])} readOnly />
      <input type="hidden" name="known_constraints" value={client?.known_constraints ?? ""} readOnly />

      {formError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200"
        >
          {formError}
        </div>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
