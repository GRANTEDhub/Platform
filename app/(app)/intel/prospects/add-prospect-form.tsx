"use client";

import { useState } from "react";
import { ORG_TYPES } from "@/lib/clients/org-types";
import { narrativeFromClient } from "@/lib/intake/narrative";
import type { Client } from "@/types/database";

// A deliberately LIGHT prospect intake — just the fields needed to map a few grants,
// separate from the full Add Client/Prospect form. Used for BOTH add (no `client`)
// and edit (a `client` to prefill). Posts to the caller's action (createClientAction
// on add, updateClientAction on edit) in prospect mode via the hidden kind=prospect,
// so the record stays a lead: staff-only, no portal, no daily matching (matched on
// demand via Run Grant Matches).
//
// The "what they do" box is stored as the narrative `mission` — emitted as the JSON
// `intake_narrative` the server parser expects (a plain string would be discarded),
// so it feeds intake_data + enrichment. Mirrors ClientForm's submit pattern (a
// successful save redirects and unmounts this; we only pass the await on an error).

const inputCls = "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";
const labelCls = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

export function AddProspectForm({
  action,
  client,
  submitLabel = "Add prospect",
}: {
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  client?: Client;
  submitLabel?: string;
}) {
  const [orgType, setOrgType] = useState(client?.org_type ?? "");
  // Prefill "what they do" from the stored narrative mission (edit); empty on add.
  const [narrative, setNarrative] = useState(
    client ? narrativeFromClient(client).mission ?? "" : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(formData: FormData) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await action(formData);
    if (result?.error) {
      setError(result.error);
      setSubmitting(false);
    }
  }

  // The narrative goes out as the JSON shape parseNarrative expects; the "what they
  // do" text is the mission. Empty -> {} (parses to an empty narrative, no clobber).
  const narrativeJson = JSON.stringify(narrative.trim() ? { mission: narrative.trim() } : {});

  return (
    <form action={handleSubmit} className="max-w-2xl space-y-6">
      <input type="hidden" name="kind" value="prospect" />
      <input type="hidden" name="intake_narrative" value={narrativeJson} readOnly />

      <div className="space-y-1.5">
        <label htmlFor="name" className={labelCls}>Organization name</label>
        <input id="name" name="name" required defaultValue={client?.name ?? ""} className={inputCls} placeholder="Acme Community Center" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="website" className={labelCls}>Website</label>
          <input id="website" name="website" type="url" defaultValue={client?.website ?? ""} className={inputCls} placeholder="https://…" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="org_type" className={labelCls}>Org type</label>
          <select
            id="org_type"
            name="org_type"
            value={orgType}
            onChange={(e) => setOrgType(e.target.value)}
            className={inputCls}
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="location_state" className={labelCls}>State</label>
          <input id="location_state" name="location_state" defaultValue={client?.location_state ?? "AR"} className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="location_city" className={labelCls}>City</label>
          <input id="location_city" name="location_city" defaultValue={client?.location_city ?? ""} className={inputCls} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="prospect_narrative" className={labelCls}>
          What they do / what they&apos;re looking to fund
        </label>
        <textarea
          id="prospect_narrative"
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
          rows={5}
          className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder="Mission, programs, and the kind of funding they need — this is the main signal the matcher uses."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="primary_contact_name" className={labelCls}>Contact name (optional)</label>
          <input id="primary_contact_name" name="primary_contact_name" defaultValue={client?.primary_contact_name ?? ""} className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="primary_contact_email" className={labelCls}>Contact email (optional)</label>
          <input id="primary_contact_email" name="primary_contact_email" type="email" defaultValue={client?.primary_contact_email ?? ""} className={inputCls} placeholder="name@org.org" />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Prospect — staff-only, no client login, no daily matching. Run grant matches on demand from the
        dashboard, then review and send one-pagers.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-50"
      >
        {submitting ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
