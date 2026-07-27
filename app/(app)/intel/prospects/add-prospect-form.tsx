"use client";

import { useState } from "react";

// A deliberately LIGHT prospect intake — just the fields needed to map a few grants,
// separate from the full Add Client/Prospect form. Posts to the SAME createClientAction
// in prospect mode (hidden kind=prospect), so the record is still written as a lead:
// staff-only, no portal, no daily matching — matched on demand via Generate report.
// Mirrors ClientForm's submit pattern (await the action; a successful create redirects
// to the new dashboard and unmounts this, so we only reach past the await on an error).

const ORG_TYPES = ["nonprofit", "local_government", "small_business", "higher_education"];

const inputCls = "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";
const labelCls = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

export function AddProspectForm({
  action,
}: {
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
}) {
  const [orgType, setOrgType] = useState("");
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

  return (
    <form action={handleSubmit} className="max-w-2xl space-y-6">
      <input type="hidden" name="kind" value="prospect" />

      <div className="space-y-1.5">
        <label htmlFor="name" className={labelCls}>Organization name</label>
        <input id="name" name="name" required className={inputCls} placeholder="Acme Community Center" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="website" className={labelCls}>Website</label>
          <input id="website" name="website" type="url" className={inputCls} placeholder="https://…" />
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
          <input id="location_state" name="location_state" defaultValue="AR" className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="location_city" className={labelCls}>City</label>
          <input id="location_city" name="location_city" className={inputCls} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="intake_narrative" className={labelCls}>
          What they do / what they&apos;re looking to fund
        </label>
        <textarea
          id="intake_narrative"
          name="intake_narrative"
          rows={5}
          className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder="Mission, programs, and the kind of funding they need — this is the main signal the matcher uses."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="primary_contact_name" className={labelCls}>Contact name (optional)</label>
          <input id="primary_contact_name" name="primary_contact_name" className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="primary_contact_email" className={labelCls}>Contact email (optional)</label>
          <input id="primary_contact_email" name="primary_contact_email" type="email" className={inputCls} placeholder="name@org.org" />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Added as a prospect — staff-only, no client login, no daily matching. Generate their grant report
        on demand from the dashboard, then review and send one-pagers.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add prospect"}
      </button>
    </form>
  );
}
