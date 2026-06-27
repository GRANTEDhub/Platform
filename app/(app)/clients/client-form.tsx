import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Client } from "@/types/database";

const ORG_TYPES = ["nonprofit", "local_government", "small_business"];
const STATUSES = ["active", "prospect", "paused", "closed"];

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
 * Shared create/edit form. The page wires `action` to the right server action.
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
  return (
    <form action={action} className="max-w-3xl space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Organization
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client name" name="name" defaultValue={client?.name} />
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
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={client?.status ?? "active"}
              className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <Field label="Engagement tier" name="engagement_tier" defaultValue={client?.engagement_tier} />
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

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Engagement
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Retainer hours" name="retainer_hours" type="number" defaultValue={client?.retainer_hours} />
          <Field label="Contract start" name="contract_start" type="date" defaultValue={client?.contract_start} />
          <Field label="Contract end" name="contract_end" type="date" defaultValue={client?.contract_end} />
        </div>
        <Field label="Next step" name="next_step" defaultValue={client?.next_step} placeholder="What's next for this client?" />
        <div className="space-y-2">
          <Label htmlFor="notes">Notes</Label>
          <textarea
            id="notes"
            name="notes"
            defaultValue={client?.notes ?? undefined}
            rows={4}
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
        </div>
      </section>

      <div className="flex gap-3">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
