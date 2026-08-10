"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SpinningMark } from "@/components/ui/spinning-mark";
import {
  useNarrative,
  NarrativeHiddenInput,
  FundingNeedField,
  MissionField,
  ProgramsSection,
  PriorityAreasSection,
} from "@/components/intake/narrative-parts";
import { ORG_TYPES } from "@/lib/clients/org-types";
import type { NarrativeIntake } from "@/lib/intake/narrative";

const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

// The client's profile confirmation -- the SINGLE implementation, mounted twice: by
// /welcome as the first-login gate's form, and by /portal/profile for later edits.
//
// It used to have a rival. /welcome rendered its own simpler form, and because the gate
// redirects there, the richer one here was unreachable on first login -- so the screen
// every new client actually saw was the one that collected no programs, no priority areas,
// and never wrote primary_funding_needs, the column the matcher reads. Two forms writing
// the same confirmation flag is a fork that resolves itself the wrong way.
//
// PREPOPULATED, not blank. Everything here was already built from their website and
// our intake, so this is a review-and-correct pass, not data entry -- which is the
// whole reason it can be asked of a client at all. It reuses the SAME narrative
// sections the staff wizard uses, so the two can never capture different things.
export function ConfirmProfile({
  orgName,
  defaults,
  narrativeDefault,
  action,
  firstLogin = false,
}: {
  orgName: string;
  defaults: {
    org_type: string | null;
    primary_contact_name: string | null;
    primary_contact_email: string | null;
    primary_contact_phone: string | null;
    website: string | null;
    location_street: string | null;
    location_city: string | null;
    location_county: string | null;
    location_state: string | null;
    location_zip: string | null;
  };
  narrativeDefault: NarrativeIntake;
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string; next?: string }>;
  firstLogin?: boolean;
}) {
  const router = useRouter();
  const narrative = useNarrative(narrativeDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function onSubmit(formData: FormData) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await action(formData);
    if (!res.ok) {
      setError(res.error ?? "Couldn't save your profile.");
      setBusy(false);
      return;
    }
    setDone(true);
    // res.next is where the client was actually headed before the first-login gate
    // intercepted them -- typically an alert email's deep link to one specific grant.
    // The action has already validated it as a same-origin /portal path.
    const destination = res.next ?? "/portal";
    setTimeout(() => router.push(destination), 3000);
  }

  // "PREPARING your grant matches" -- not "matching". The matching already ran, so
  // claiming it is happening now would be theatre; preparing them for you is what is
  // actually going on, and it reads just as fast.
  if (done && mounted) {
    return createPortal(
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center"
      >
        <h2 className="font-serif text-2xl font-semibold text-brand-navy">Profile confirmed</h2>
        <SpinningMark />
        <p className="text-sm text-muted-foreground">Preparing your grant matches</p>
      </div>,
      document.body,
    );
  }

  return (
    <form action={onSubmit} className="space-y-8">
      <NarrativeHiddenInput c={narrative} />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your organization
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="org_type">Organization type</Label>
            <select
              id="org_type"
              name="org_type"
              defaultValue={defaults.org_type ?? ""}
              className={SELECT_CLASS}
            >
              <option value="">Select one…</option>
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
          Who to reach
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact name" name="primary_contact_name" defaultValue={defaults.primary_contact_name} />
          <Field label="Contact email" name="primary_contact_email" defaultValue={defaults.primary_contact_email} />
          <Field label="Phone" name="primary_contact_phone" defaultValue={defaults.primary_contact_phone} />
          <Field label="Website" name="website" defaultValue={defaults.website} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Location</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Street" name="location_street" defaultValue={defaults.location_street} />
          <Field label="City" name="location_city" defaultValue={defaults.location_city} />
          {/* County is asked for explicitly because it is what our rurality lookup is
              keyed on, and it is the field most often missing after an address import. */}
          <Field label="County" name="location_county" defaultValue={defaults.location_county} />
          <Field label="State" name="location_state" defaultValue={defaults.location_state} />
          <Field label="ZIP" name="location_zip" defaultValue={defaults.location_zip} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What you do
        </h2>
        <MissionField c={narrative} help="What your organization does and who it serves." />
        <ProgramsSection
          c={narrative}
          status="existing"
          title="Programs you run today"
          help="Correct anything we got wrong, and add what we missed."
          addLabel="+ Add a program"
          collapsible
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What you need funded
        </h2>
        <FundingNeedField
          c={narrative}
          label="What are you looking to fund?"
          help="The more specific, the better your matches."
        />
        <PriorityAreasSection c={narrative} help="Used to highlight opportunities in your report." />
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : firstLogin ? "Confirm & continue" : "Confirm profile"}
        </Button>
        <span className="text-xs text-muted-foreground">
          You can change any of this later from your profile.
        </span>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue: string | null;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue ?? undefined} />
    </div>
  );
}
