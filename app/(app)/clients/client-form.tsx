"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChipInput } from "@/components/ui/chip-input";
import { MatchingConfig } from "./matching-config";
import { NarrativeFields } from "@/components/intake/narrative-fields";
import { narrativeFromClient } from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client } from "@/types/database";

const ORG_TYPES = ["nonprofit", "local_government", "small_business", "higher_education"];
// Client-only statuses. Prospect/lead state is driven by the kind toggle (a
// prospect is written status='lead' + pipeline_stage='discovery_pending' server-
// side), so it is not an option here.
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
 * Shared create/edit form for a client OR a prospect. The `kind` radio is the
 * first field and drives conditional UI (engagement section shows for clients
 * only); the server action (actions.ts) is authoritative for the prospect-safe
 * write (status='lead', pipeline_stage='discovery_pending', engagement_tier=null).
 * The page wires `action` to createClientAction / updateClientAction.
 */
export function ClientForm({
  client,
  action,
  submitLabel,
}: {
  client?: Client;
  action: (formData: FormData) => void;
  submitLabel: string;
}) {
  // On edit, default the toggle from the stored row: an un-converted lead
  // (pipeline_stage set, not 'converted') is a prospect; otherwise a client.
  const initialKind: "client" | "prospect" =
    client && isUnconvertedLead(client.pipeline_stage) ? "prospect" : "client";
  const [kind, setKind] = useState<"client" | "prospect">(initialKind);
  const isClient = kind === "client";

  return (
    <form action={action} className="max-w-3xl space-y-8">
      {/* 1. Kind -- required, first, drives the conditional UI below. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Record type
        </h2>
        <div className="flex gap-6">
          {(["client", "prospect"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                required
              />
              {k === "client" ? "Client" : "Prospect"}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {isClient
            ? "An active client the matcher scores against live grants."
            : "An outreach target — never scored by the matcher until converted to a client."}
        </p>
      </section>

      {/* 2. Organization + contact + location -- always shown (parity with public intake). */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Organization
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="name" defaultValue={client?.name} />
          <div className="space-y-2">
            <Label htmlFor="org_type">Org type</Label>
            <select
              id="org_type"
              name="org_type"
              defaultValue={client?.org_type ?? ""}
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
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Primary contact
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="primary_contact_name" defaultValue={client?.primary_contact_name} />
          <Field label="Email" name="primary_contact_email" type="email" defaultValue={client?.primary_contact_email} />
          <Field label="Phone" name="primary_contact_phone" defaultValue={client?.primary_contact_phone} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Location
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City" name="location_city" defaultValue={client?.location_city} />
          <Field label="County" name="location_county" defaultValue={client?.location_county} />
          <Field label="State" name="location_state" defaultValue={client?.location_state ?? "AR"} />
        </div>
      </section>

      {/* 3. Narrative -- 1:1 with the public intake (shared component). */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Narrative
        </h2>
        <p className="text-xs text-muted-foreground">
          Feeds the client profile (enrichment). Mission, programs + who they serve, priority
          areas, partnerships. Not used for seat/eligibility scoring.
        </p>
        <NarrativeFields defaultValue={client ? narrativeFromClient(client) : undefined} />
      </section>

      {/* 4. Notes -- always shown (general CRM). */}
      <section className="space-y-4">
        <Field label="Next step" name="next_step" defaultValue={client?.next_step} placeholder="What's next for this record?" />
        <div className="space-y-2">
          <Label htmlFor="notes">Internal notes</Label>
          <textarea
            id="notes"
            name="notes"
            defaultValue={client?.notes ?? undefined}
            rows={4}
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Not used for seat/eligibility scoring. Shown internally and distilled into the client
            profile narrative.
          </p>
        </div>
      </section>

      {/* 5. Engagement -- CLIENTS ONLY. Hidden for prospects; the server writes the
          prospect-safe status/stage/tier regardless of what is (not) submitted here. */}
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
        </section>
      )}

      {/* 6. Grant-matching profile -- admin-only, optional. Scoring-relevant raw fields. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Grant-matching profile{" "}
          <span className="font-normal normal-case text-muted-foreground">(optional)</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Used by the matching engine. Not financial data — visible to contractors.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Match / cost-share capacity" name="match_cost_share_capacity" defaultValue={client?.match_cost_share_capacity} />
          <Field label="Annual budget" name="annual_budget" defaultValue={client?.annual_budget} />
          <Field label="Project stage" name="project_stage" defaultValue={client?.project_stage} placeholder="e.g. planning, implementation" />
          <Field label="RUCC codes" name="rucc_codes" defaultValue={client?.rucc_codes} />
        </div>
        <ChipInput
          name="service_area"
          label="Service area"
          defaultValue={client?.service_area ?? undefined}
          placeholder="Type a county or region, press Enter"
        />
      </section>

      {/* 7. Matching config -- admin-only, optional. */}
      <MatchingConfig
        defaultConstraints={client?.hard_constraints ?? []}
        defaultMatchingRules={client?.matching_rules}
        defaultKnownConstraints={client?.known_constraints}
      />

      <div className="flex gap-3">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
