"use client";

import { useState } from "react";
import Script from "next/script";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ORG_TYPES, REFERRAL_SOURCES, US_STATES } from "@/lib/intake/fields";
import { NarrativeFields } from "@/components/intake/narrative-fields";
import { ChipInput } from "@/components/ui/chip-input";

const FIELD = "flex h-11 w-full rounded-md border border-input bg-white px-3 py-2 text-sm";

// Public intake form. Posts to /api/intake, which creates an inbound lead. Lean
// by design: only what the org uniquely knows. Honeypot + optional Turnstile
// guard against bots. On success the form is replaced by a confirmation panel.
export function IntakeForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [org, setOrg] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [orgType, setOrgType] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [referral, setReferral] = useState("");
  const [honeypot, setHoneypot] = useState(""); // hidden; bots fill it

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const turnstileToken = turnstileSiteKey
        ? (document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')?.value ?? "")
        : undefined;
      if (turnstileSiteKey && !turnstileToken) {
        throw new Error("Please complete the captcha.");
      }
      // Read the narrative + service-area chips from their hidden inputs (same
      // pattern as the Turnstile token above); the server parses them.
      const narrative =
        document.querySelector<HTMLInputElement>('[name="intake_narrative"]')?.value ?? "";
      const serviceArea =
        document.querySelector<HTMLInputElement>('[name="service_area"]')?.value ?? "";
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgName: org,
          contactName: contact,
          email,
          phone,
          orgType,
          city,
          state,
          narrative,
          serviceArea,
          referralSource: referral,
          website: honeypot,
          turnstileToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-input bg-white p-8 text-center">
        <h2 className="font-serif text-2xl font-semibold text-brand-navy">Thanks — we&apos;ve got it.</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          Your intake is in. A GRANTED advisor will follow up within one business day to schedule your
          discovery call.
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      {turnstileSiteKey && <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Field label="Organization name" required>
        <Input value={org} onChange={(e) => setOrg(e.target.value)} required />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" required>
          <Input value={contact} onChange={(e) => setContact(e.target.value)} required />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone (optional)">
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Organization type" required>
          <select value={orgType} onChange={(e) => setOrgType(e.target.value)} className={FIELD} required>
            <option value="" disabled>
              Choose one…
            </option>
            {ORG_TYPES.map((t) => (
              <option key={t.code} value={t.label}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="City" required>
            <Input value={city} onChange={(e) => setCity(e.target.value)} required />
          </Field>
        </div>
        <Field label="State" required>
          <select value={state} onChange={(e) => setState(e.target.value)} className={FIELD} required>
            <option value="" disabled>
              —
            </option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <ChipInput
        name="service_area"
        label="Service area (counties or regions you serve)"
        placeholder="Type a county or region, press Enter"
      />

      <NarrativeFields fundingNeedRequired />

      <Field label="How did you hear about us? (optional)">
        <select value={referral} onChange={(e) => setReferral(e.target.value)} className={FIELD}>
          <option value="">—</option>
          {REFERRAL_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>

      {/* Honeypot: visually hidden, off the tab order. Bots fill it; humans don't. */}
      <div aria-hidden className="absolute left-[-9999px] top-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </label>
      </div>

      {turnstileSiteKey && <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />}

      <Button type="submit" disabled={busy} className="w-full sm:w-auto">
        {busy ? "Submitting…" : "Submit intake"}
      </Button>
    </form>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="ml-0.5 text-brand-orange">*</span>}
      </Label>
      {children}
    </div>
  );
}
