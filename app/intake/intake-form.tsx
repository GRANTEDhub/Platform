"use client";

import { useState } from "react";
import Script from "next/script";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ORG_TYPES, PRIORITY_AREAS, REFERRAL_SOURCES, US_STATES } from "@/lib/intake/fields";

const FIELD = "flex h-11 w-full rounded-md border border-input bg-white px-3 py-2 text-sm";
const AREA = "flex w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-relaxed";

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
  const [areas, setAreas] = useState<string[]>([]);
  const [need, setNeed] = useState("");
  const [additional, setAdditional] = useState("");
  const [referral, setReferral] = useState("");
  const [honeypot, setHoneypot] = useState(""); // hidden; bots fill it

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const toggleArea = (a: string) =>
    setAreas((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

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
          priorityAreas: areas,
          fundingNeed: need,
          additionalInfo: additional,
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

      <Field label="What are you looking for?" required>
        <textarea
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          rows={4}
          maxLength={2000}
          className={AREA}
          placeholder="A sentence or two on what you're hoping to fund — a program, staffing, equipment, a project…"
          required
        />
      </Field>

      <div>
        <Label>Priority funding areas (optional)</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {PRIORITY_AREAS.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" checked={areas.includes(a)} onChange={() => toggleArea(a)} />
              {a}
            </label>
          ))}
        </div>
      </div>

      <Field label="Anything else we should know? (optional)">
        <textarea
          value={additional}
          onChange={(e) => setAdditional(e.target.value)}
          rows={3}
          maxLength={2000}
          className={AREA}
        />
      </Field>

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
