"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { inviteClientAction, type InviteState } from "../invite-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

// Lean invite form: org name, primary contact, and package. On success it swaps
// to a confirmation ("invitation sent") rather than navigating, so staff get the
// "transition" beat before heading back to the Portfolio. The client then gets a
// Welcome email with a setup link (see invite-actions.ts).
export function InviteClientForm() {
  const [state, setState] = useState<InviteState>({ ok: false });
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      setState(await inviteClientAction(formData));
    });
  }

  if (state.ok) {
    return (
      <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-8 text-center shadow-grounded">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-orange/12 text-brand-orange">
          <CheckCircle2 className="h-6 w-6" />
        </span>
        <h2 className="mt-4 font-serif text-xl font-semibold text-brand-navy">Invitation sent</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          {state.invitedName} is set up.{" "}
          {state.emailed
            ? `A welcome email is on its way to ${state.invitedEmail} to set up their account and confirm their profile.`
            : `Email sending is off in this environment, so no welcome email went out — the client + login exist, and the email will send from production.`}
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link href="/clients">
            <Button>Back to Portfolio</Button>
          </Link>
          <button
            type="button"
            onClick={() => setState({ ok: false })}
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
          >
            Invite another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name">Organization name</Label>
        <Input id="name" name="name" required placeholder="e.g. UAMS NorthWest" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="contact_name">Point of contact</Label>
          <Input id="contact_name" name="contact_name" placeholder="Full name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact_email">Contact email</Label>
          <Input id="contact_email" name="contact_email" type="email" required placeholder="name@org.org" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-brand-navy">Package</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-brand-navy/[0.1] bg-white p-4 transition hover:border-brand-navy/25 has-[:checked]:border-brand-orange has-[:checked]:bg-brand-orange/[0.04]">
            <input type="radio" name="package" value="build" required className="mt-0.5 accent-brand-orange" />
            <span>
              <span className="block text-sm font-semibold text-brand-navy">Build</span>
              <span className="block text-xs text-muted-foreground">Self-serve grant workspace.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-brand-navy/[0.1] bg-white p-4 transition hover:border-brand-navy/25 has-[:checked]:border-brand-orange has-[:checked]:bg-brand-orange/[0.04]">
            <input type="radio" name="package" value="enterprise" className="mt-0.5 accent-brand-orange" />
            <span>
              <span className="block text-sm font-semibold text-brand-navy">Enterprise</span>
              <span className="block text-xs text-muted-foreground">Account-managed, full-service.</span>
            </span>
          </label>
        </div>
      </fieldset>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}

      <div className="flex items-center gap-4 pt-1">
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invitation"}
        </Button>
        <Link
          href="/clients/new"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
        >
          Enter it myself instead →
        </Link>
      </div>
    </form>
  );
}
