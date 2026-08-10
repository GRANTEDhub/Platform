"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, UserPlus } from "lucide-react";
import { inviteTeammateAction, type TeammateState } from "@/app/welcome/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

// "Invite a teammate" -- the client adding a second seat themselves, offered alongside
// the first-login profile confirmation.
//
// Lifted out of the retired WelcomeForm unchanged. It lives here rather than beside the
// /welcome page because it is a sibling of ConfirmProfile in the layout, not part of it:
// this is its own <form>, and nesting it inside the profile form would be invalid HTML.
export function TeammateInvite({ orgName }: { orgName: string }) {
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
