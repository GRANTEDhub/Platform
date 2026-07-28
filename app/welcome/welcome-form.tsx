"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, UserPlus } from "lucide-react";
import {
  confirmProfileAction,
  inviteTeammateAction,
  type ConfirmState,
  type TeammateState,
} from "./actions";
import { ORG_TYPES } from "@/lib/clients/org-types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export interface WelcomeDefaults {
  org_type: string;
  website: string;
  contact_name: string;
  location_city: string;
  location_county: string;
  location_state: string;
  location_street: string;
  location_zip: string;
  mission: string;
  funding_need: string;
}

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

export function WelcomeForm({ orgName, defaults }: { orgName: string; defaults: WelcomeDefaults }) {
  const router = useRouter();
  const [state, setState] = useState<ConfirmState>({ ok: false });
  const [pending, startTransition] = useTransition();

  function onConfirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await confirmProfileAction(formData);
      setState(result);
      if (result.ok) {
        router.push("/portal");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-8">
      <form onSubmit={onConfirm} className="space-y-6">
        <fieldset className="space-y-5">
          <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Your organization
          </legend>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org_type">Organization type</Label>
              <select id="org_type" name="org_type" defaultValue={defaults.org_type} className={SELECT_CLASS}>
                <option value="">Select one…</option>
                {ORG_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input id="website" name="website" defaultValue={defaults.website} placeholder="https://…" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact_name">Primary contact</Label>
            <Input id="contact_name" name="contact_name" defaultValue={defaults.contact_name} placeholder="Full name" />
          </div>
        </fieldset>

        <fieldset className="space-y-5">
          <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Location
          </legend>
          <div className="space-y-2">
            <Label htmlFor="location_street">Street address</Label>
            <Input
              id="location_street"
              name="location_street"
              defaultValue={defaults.location_street}
              placeholder="123 Main St"
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="location_city">City</Label>
              <Input id="location_city" name="location_city" defaultValue={defaults.location_city} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="location_county">County</Label>
              <Input id="location_county" name="location_county" defaultValue={defaults.location_county} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="location_state">State</Label>
              <Input id="location_state" name="location_state" defaultValue={defaults.location_state} placeholder="AR" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="location_zip">ZIP</Label>
              <Input id="location_zip" name="location_zip" defaultValue={defaults.location_zip} />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-5">
          <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            About your work
          </legend>
          <div className="space-y-2">
            <Label htmlFor="mission">Mission — what your organization does</Label>
            <textarea
              id="mission"
              name="mission"
              defaultValue={defaults.mission}
              rows={3}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="A sentence or two on your mission and the people you serve."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="funding_need">What you're hoping grant funding will support</Label>
            <textarea
              id="funding_need"
              name="funding_need"
              defaultValue={defaults.funding_need}
              rows={3}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Programs, projects, capacity, or capital you'd like funded."
            />
          </div>
        </fieldset>

        {state.error && <p className="text-sm text-destructive">{state.error}</p>}

        <div className="flex items-center gap-4 pt-1">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Confirm & go to my dashboard"}
          </Button>
          <span className="text-xs text-muted-foreground">
            You can update any of this later — your GRANTED team can help.
          </span>
        </div>
      </form>

      <div className="border-t border-brand-navy/[0.08] pt-8">
        <TeammateInvite orgName={orgName} />
      </div>
    </div>
  );
}

function TeammateInvite({ orgName }: { orgName: string }) {
  const [state, setState] = useState<TeammateState>({ ok: false });
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    startTransition(async () => {
      const result = await inviteTeammateAction(formData);
      setState(result);
      if (result.ok) form.reset();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-orange/12 text-brand-orange">
          <UserPlus className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-serif text-lg font-semibold text-brand-navy">Invite a teammate</h2>
          <p className="text-sm text-muted-foreground">
            Optional — add a colleague at {orgName} so they can see your grant matches too.
          </p>
        </div>
      </div>

      {state.ok ? (
        <p className="flex items-center gap-2 text-sm text-brand-navy">
          <CheckCircle2 className="h-4 w-4 text-brand-orange" />
          Invited {state.invitedEmail}.{" "}
          {state.emailed
            ? "A welcome email is on its way."
            : "Email sending is off in this environment — the login exists and the email will send from production."}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="teammate_name">Name</Label>
          <Input id="teammate_name" name="teammate_name" placeholder="Full name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="teammate_email">Email</Label>
          <Input id="teammate_email" name="email" type="email" placeholder="name@org.org" />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Inviting…" : "Send invite"}
        </Button>
      </form>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </div>
  );
}
