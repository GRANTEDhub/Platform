"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChipInput } from "@/components/ui/chip-input";
import { NarrativeFields } from "@/components/intake/narrative-fields";
import { AddressAutocomplete } from "@/components/clients/address-autocomplete";
import {
  narrativeFromClient,
  EMPTY_NARRATIVE,
  type NarrativeProgram,
  type NarrativePartner,
} from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { ORG_TYPES } from "@/lib/clients/org-types";
import type { Client } from "@/types/database";

// Client-only statuses. Prospect/lead state is written server-side
// (status='lead' + pipeline_stage='discovery_pending'), never chosen here.
const CLIENT_STATUSES = ["active", "paused", "closed"];

// What POST /api/enrich/website returns: everything it could extract from the org's
// site, with "" for anything the page did not support (never guessed). Consumed as
// the form's default values in the URL-first flow.
type Crafted = {
  name: string;
  org_type: string;
  address: string;
  city: string;
  county: string;
  state: string;
  zip: string;
  primary_contact_name: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  ein: string;
  mission: string;
  funding_need: string;
  programs: NarrativeProgram[];
  partners: NarrativePartner[];
  service_area: string[];
};

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

  // ── URL-first flow (CREATE only) ──────────────────────────────────────────
  // A new record opens with ONLY the website field: paste a URL, click Craft
  // profile, and the rest of the form appears already filled in with whatever the
  // site yielded. "No website" opens the same form blank. On EDIT everything is
  // revealed immediately (the record already exists, nothing to craft).
  const [revealed, setRevealed] = useState(!!client);
  const [crafted, setCrafted] = useState<Crafted | null>(null);
  const [crafting, setCrafting] = useState(false);
  const [craftError, setCraftError] = useState<string | null>(null);
  const [craftNote, setCraftNote] = useState<string | null>(null);

  const validUrl = (() => {
    try {
      const u = new URL(website.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  })();

  async function craftProfile() {
    setCrafting(true);
    setCraftError(null);
    setCraftNote(null);
    try {
      const res = await fetch("/api/enrich/website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: website.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Couldn't read that site.");
      const c = d as Crafted;
      setCrafted(c);
      if (c.org_type) setOrgType(c.org_type);
      // Name what the site did NOT yield, so the blanks read as "not found" rather
      // than "the tool is broken".
      const missing = [
        !c.name && "name",
        !c.address && "address",
        !c.primary_contact_email && "contact email",
      ].filter(Boolean) as string[];
      setCraftNote(
        missing.length
          ? `Filled in what the site supported. Not found: ${missing.join(", ")} — add by hand.`
          : "Filled in from the site. Review everything before saving.",
      );
      setRevealed(true);
    } catch (e) {
      setCraftError(e instanceof Error ? e.message : "Couldn't read that site.");
    } finally {
      setCrafting(false);
    }
  }

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

      {/* 1. Website — the opening, and on CREATE the only thing shown until the
          profile is crafted (or "no website" is chosen). */}
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
        {!revealed ? (
          <>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Start here.</span> Paste the organization&apos;s website and
              craft the profile — the rest of the form opens prefilled with whatever the site supports.
              Everything stays editable.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button type="button" disabled={!validUrl || crafting} onClick={craftProfile}>
                {crafting ? "Reading the site…" : "Craft profile"}
              </Button>
              <button
                type="button"
                disabled={crafting}
                onClick={() => {
                  setCraftError(null);
                  setCraftNote(null);
                  setRevealed(true);
                }}
                className="text-sm font-medium text-brand-orange hover:underline disabled:opacity-50"
              >
                Don&apos;t have a website? Fill it in manually →
              </button>
            </div>
            {crafting && (
              <p className="text-xs text-muted-foreground">
                Fetching the site and extracting the profile — usually a few seconds.
              </p>
            )}
            {craftError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {craftError} You can still{" "}
                <button type="button" onClick={() => setRevealed(true)} className="font-medium underline">
                  fill the form in manually
                </button>
                .
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Used for enrichment and to craft the profile. Everything below stays editable.
          </p>
        )}
      </section>

      {/* Everything below is GATED on the URL-first step (create): it renders once the
          profile is crafted or the admin opts to fill it in by hand. On edit it shows
          immediately. The crafted values are the mount-time defaults, so the fields
          appear prefilled and fully editable. */}
      {revealed && (
        <>
      {craftNote && (
        <p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {craftNote}
        </p>
      )}

      {/* 2. Organization. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Organization</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="name" defaultValue={client?.name ?? crafted?.name} />
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
          <Field label="Name" name="primary_contact_name" defaultValue={client?.primary_contact_name ?? crafted?.primary_contact_name} />
          <Field label="Email" name="primary_contact_email" type="email" defaultValue={client?.primary_contact_email ?? crafted?.primary_contact_email} />
          {isClient && (
            <Field label="Phone" name="primary_contact_phone" defaultValue={client?.primary_contact_phone ?? crafted?.primary_contact_phone} />
          )}
        </div>
      </section>

      {/* 4. Location — typeahead on street address fills city/county/state/ZIP.
          Degrades to plain typed inputs with no key / on any API failure. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Location</h2>
        <AddressAutocomplete
          defaultStreet={client?.location_street}
          defaultCity={client?.location_city ?? crafted?.city}
          defaultCounty={client?.location_county ?? crafted?.county}
          defaultState={client?.location_state ?? crafted?.state}
          defaultZip={client?.location_zip ?? crafted?.zip}
          defaultLine={crafted?.address}
        />
      </section>

      {/* 5. Narrative — the matching-relevant signal. Prospects get the light set
          (intent + mission + priority areas); clients get the full set. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Narrative</h2>
        <p className="text-xs text-muted-foreground">
          Feeds the profile (enrichment) and grounds matching. Not used for seat/eligibility scoring.
        </p>
        <NarrativeFields
          defaultValue={
            client
              ? narrativeFromClient(client)
              : crafted
                ? {
                    ...EMPTY_NARRATIVE,
                    mission: crafted.mission,
                    funding_need: crafted.funding_need,
                    programs: crafted.programs ?? [],
                    partners: crafted.partners ?? [],
                  }
                : undefined
          }
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
            <Field label="RUCC codes" name="rucc_codes" defaultValue={client?.rucc_codes} placeholder="Blank = auto-fill from county (USDA ERS 2023)" />
            <Field label="IRS EIN" name="ein" defaultValue={client?.ein ?? crafted?.ein} placeholder="e.g. 71-0236875 — pulls annual budget from the IRS 990" />
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
            defaultValue={client?.service_area ?? crafted?.service_area ?? undefined}
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
        </>
      )}
    </form>
  );
}
