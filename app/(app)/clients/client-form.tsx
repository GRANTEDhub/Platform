"use client";

import { useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChipInput } from "@/components/ui/chip-input";
import { AddressAutocomplete } from "@/components/clients/address-autocomplete";
import { CreateTransition } from "@/components/clients/create-transition";
import {
  useNarrative,
  NarrativeHiddenInput,
  FundingNeedField,
  MissionField,
  ProgramsSection,
  PriorityAreasSection,
  PartnersSection,
  AdditionalInfoField,
} from "@/components/intake/narrative-parts";
import {
  narrativeFromClient,
  type NarrativeProgram,
  type NarrativePartner,
} from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { ORG_TYPES } from "@/lib/clients/org-types";
import type { Client } from "@/types/database";

// Client-only statuses. Prospect/lead state is written server-side
// (status='lead' + pipeline_stage='discovery_pending'), never chosen here.
const CLIENT_STATUSES = ["active", "paused", "closed"];

// What POST /api/enrich/website returns: everything it could extract from the org's
// site, with "" for anything the page did not support (never guessed).
type Crafted = {
  name: string;
  org_type: string;
  address: string;
  city: string;
  county: string;
  state: string;
  zip: string;
  primary_contact_name: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  ein: string;
  mission: string;
  funding_need: string;
  programs: NarrativeProgram[];
  partners: NarrativePartner[];
  service_area: string[];
};

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
  );
}

/**
 * The create/edit form for a client OR a prospect, in two shapes from one source:
 *
 *  - CREATE -> a STEPPED WIZARD. Step 1 is the website + "Craft profile"; the
 *    remaining steps are the crafted profile broken into digestible pages
 *    (general info, needs, partnerships, anything-else, engagement).
 *  - EDIT   -> ONE scrolling page, because editing is "jump to the field I care
 *    about", not a guided intake. Edit also keeps the admin-only grant-matching
 *    profile + matcher note, which are deliberately absent from intake.
 *
 * Two constraints shape the wizard's implementation:
 *  1. Steps are MOUNTED ONCE REACHED and then hidden with CSS, never unmounted --
 *     an unmounted input is dropped from FormData, which would silently discard a
 *     completed page on the way back to submit.
 *  2. Non-narrative fields are uncontrolled (defaultValue), so a step must not mount
 *     until the craft has landed or its crafted prefill would be missed. The
 *     mount-once-reached rule gives that for free: step 2+ can only be reached after
 *     step 1 is done with.
 *
 * `kind` is fixed by the entry point (create) or derived from the row (edit); the
 * server action stays authoritative for the prospect-safe write.
 */
export function ClientForm({
  client,
  action,
  submitLabel,
  defaultKind,
}: {
  client?: Client;
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  submitLabel: string;
  defaultKind?: "client" | "prospect";
}) {
  const isEdit = !!client;
  const kind: "client" | "prospect" = !client
    ? defaultKind ?? "client"
    : isUnconvertedLead(client.pipeline_stage)
      ? "prospect"
      : "client";
  const isClient = kind === "client";
  const kindLabel = isClient ? "client" : "prospect";

  const [orgType, setOrgType] = useState(client?.org_type ?? "");
  const showResearchOptIn = orgType === "small_business" || orgType === "higher_education";
  const [website, setWebsite] = useState(client?.website ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Narrative state is lifted here (rather than owned by NarrativeFields) so its
  // sections can be spread across wizard steps while ONE hidden input carries the
  // whole shape. See components/intake/narrative-parts.tsx.
  const narrative = useNarrative(client ? narrativeFromClient(client) : undefined);

  const [crafted, setCrafted] = useState<Crafted | null>(null);
  const [crafting, setCrafting] = useState(false);
  const [craftError, setCraftError] = useState<string | null>(null);
  const [craftNote, setCraftNote] = useState<string | null>(null);

  // Wizard position. `maxStep` is the high-water mark: every step up to it stays
  // mounted (hidden) so its values survive navigation.
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A PROSPECT intake stays deliberately light: website -> general -> needs. The
  // partnership / anything-else / engagement depth is for a signed client, not an
  // outreach target. Their narrative keys still round-trip through the hidden input
  // (empty), so nothing is dropped if a prospect is later promoted.
  const steps: { key: string; title: string }[] = isClient
    ? [
        { key: "start", title: "Website" },
        { key: "general", title: "General information" },
        { key: "needs", title: "What you need funded" },
        { key: "partnerships", title: "Partnerships" },
        { key: "anything", title: "Anything else" },
        { key: "engagement", title: "Engagement" },
      ]
    : [
        { key: "start", title: "Website" },
        { key: "general", title: "General information" },
        { key: "needs", title: "What you need funded" },
      ];
  const lastStep = steps.length - 1;
  const hasStep = (key: string) => steps.some((s) => s.key === key);

  const validUrl = (() => {
    try {
      const u = new URL(website.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  })();

  async function craftProfile() {
    setCrafting(true);
    setCraftError(null);
    setCraftNote(null);
    try {
      const res = await fetch("/api/enrich/website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: website.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Couldn't read that site.");
      const c = d as Crafted;
      setCrafted(c);
      if (c.org_type) setOrgType(c.org_type);
      // The narrative is CONTROLLED, so crafted values are patched in rather than
      // relying on a mount-time default (unlike the uncontrolled text fields).
      narrative.patch({
        mission: c.mission || narrative.n.mission,
        funding_need: c.funding_need || narrative.n.funding_need,
        programs: c.programs?.length ? c.programs : narrative.n.programs,
        partners: c.partners?.length ? c.partners : narrative.n.partners,
      });
      const missing = [
        !c.name && "name",
        !c.address && "address",
        !c.primary_contact_email && "contact email",
        !c.programs?.length && "programs",
      ].filter(Boolean) as string[];
      setCraftNote(
        missing.length
          ? `Filled in what the site supported. Not found: ${missing.join(", ")} — add by hand.`
          : "Filled in from the site. Review each step before saving.",
      );
      // Advance on its own after a beat, so the confirmation is legible before the
      // page changes under you. goNext (not setStep) so the mounted-once-reached
      // high-water mark advances too -- otherwise step 2 never mounts and its
      // crafted prefill is lost.
      window.setTimeout(() => goNext(), 1000);
    } catch (e) {
      setCraftError(e instanceof Error ? e.message : "Couldn't read that site.");
    } finally {
      setCrafting(false);
    }
  }

  async function handleSubmit(formData: FormData) {
    if (submitting) return;
    // BACKSTOP: in the wizard, a save is only ever legitimate from the last step.
    // Anything else is a stray submit (a focused button, an Enter keypress, a
    // type-flipped node) and must not create the record halfway through the intake.
    // Deliberately independent of the DOM/React fix above -- this one cannot be
    // defeated by a reconciliation detail.
    if (!isEdit && step !== lastStep) return;
    setSubmitting(true);
    setFormError(null);
    const result = await action(formData);
    if (result?.error) {
      setFormError(result.error);
      setSubmitting(false);
    }
  }

  // Name is the one field the server hard-requires. Catch it while its step is on
  // screen -- submitting happens on the LAST step, so a server-side rejection would
  // otherwise surface an error several steps away from the field that caused it.
  function goNext() {
    if (steps[step].key === "general") {
      const el = formRef.current?.elements.namedItem("name");
      const value = el instanceof HTMLInputElement ? el.value.trim() : "";
      if (!value) {
        setStepError(`A ${kindLabel} name is required before continuing.`);
        (el as HTMLInputElement | null)?.focus();
        return;
      }
    }
    setStepError(null);
    const next = Math.min(step + 1, lastStep);
    setStep(next);
    setMaxStep((m) => Math.max(m, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function goBack() {
    setStepError(null);
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // In edit mode everything is mounted and visible (one scrolling page). In wizard
  // mode a step renders once reached, and only the current one is visible.
  const mounted = (i: number) => isEdit || i <= maxStep;
  const stepClass = (i: number) => (isEdit || i === step ? "space-y-8" : "hidden");

  return (
    // noValidate on the WIZARD only. Steps are hidden with CSS while still mounted,
    // and the browser refuses to submit a form containing an invalid control it
    // cannot focus (e.g. a malformed primary_contact_email on an off-screen step) --
    // it aborts with a console warning and NO visible error, so the Save button just
    // appears dead. Validation is the server's job here; the one hard requirement
    // (name) is caught by goNext while its step is on screen. Edit shows everything
    // at once, so native validation is safe and useful there.
    <form ref={formRef} action={handleSubmit} noValidate={!isEdit} className="max-w-3xl space-y-8">
      {submitting && !isEdit && <CreateTransition kindLabel={kindLabel} />}

      <input type="hidden" name="kind" value={kind} />
      {/* Mounted exactly once for the whole form -- carries the entire narrative. */}
      <NarrativeHiddenInput c={narrative} />

      {/* Wizard progress. Hidden on edit (no steps there). */}
      {!isEdit && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium uppercase tracking-wide">
              Step {step + 1} of {steps.length} · {steps[step].title}
            </span>
            <span>New {kindLabel}</span>
          </div>
          <div className="flex gap-1.5">
            {steps.map((s, i) => (
              <span
                key={s.key}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= step ? "bg-brand-orange" : "bg-brand-navy/10"
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {isEdit && (
        <p className="text-sm text-muted-foreground">
          Editing {kindLabel}
          {!isClient && " — staff-only, no client login, no daily matching (matched on demand)."}
        </p>
      )}

      {craftNote && (
        <p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {craftNote}
        </p>
      )}

      {/* ── Step 1: website + craft ─────────────────────────────────────────── */}
      <div className={stepClass(0)}>
        <section className="space-y-2">
          <SectionTitle>Website</SectionTitle>
          <Input
            id="website"
            name="website"
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://…"
          />
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Used for enrichment and to craft the profile.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Start here.</span> Paste the organization&apos;s website and
                craft the profile — the following steps open prefilled with whatever the site supports.
                No website? Just continue and fill it in by hand.
              </p>
              {/* Once the craft lands the button becomes a settled confirmation, not
                  another thing to click -- the old version only signalled success by
                  relabelling itself "Re-craft profile", which reads as "nothing
                  happened". It then advances on its own, because the whole point of
                  crafting is to go review the result. */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {crafted ? (
                  <span className="inline-flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    Profile created
                  </span>
                ) : (
                  <Button type="button" variant="outline" disabled={!validUrl || crafting} onClick={craftProfile}>
                    {crafting ? "Reading the site…" : "Craft profile"}
                  </Button>
                )}
              </div>
              {crafting && (
                <p className="text-xs text-muted-foreground">
                  Fetching the site and extracting the profile — usually a few seconds.
                </p>
              )}
              {craftError && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {craftError} You can continue and fill the steps in manually.
                </p>
              )}
            </>
          )}
        </section>
      </div>

      {/* ── Step 2: general information ─────────────────────────────────────── */}
      {mounted(1) && (
        <div className={stepClass(1)}>
          <section className="space-y-4">
            <SectionTitle>Organization</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" name="name" defaultValue={client?.name ?? crafted?.name} />
              <div className="space-y-2">
                <Label htmlFor="org_type">Org type</Label>
                <select
                  id="org_type"
                  name="org_type"
                  value={orgType}
                  onChange={(e) => setOrgType(e.target.value)}
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

            {isClient && showResearchOptIn && (
              <label className="flex items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-sm">
                <input
                  type="checkbox"
                  name="research_opt_in"
                  value="true"
                  defaultChecked={!!client?.research_opt_in}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Include research grants for this client</span>
                  <span className="block text-xs text-muted-foreground">
                    Off by default. GRANTED excludes research funders (e.g. NIH) from matching and the
                    forecast horizon. Check this only if this organization pursues federal research grants.
                  </span>
                </span>
              </label>
            )}
          </section>

          <section className="space-y-4">
            <SectionTitle>Primary contact</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" name="primary_contact_name" defaultValue={client?.primary_contact_name ?? crafted?.primary_contact_name} />
              <Field label="Email" name="primary_contact_email" type="email" defaultValue={client?.primary_contact_email ?? crafted?.primary_contact_email} />
              {isClient && (
                <Field label="Phone" name="primary_contact_phone" defaultValue={client?.primary_contact_phone ?? crafted?.primary_contact_phone} />
              )}
            </div>
          </section>

          <section className="space-y-4">
            <SectionTitle>Location</SectionTitle>
            <AddressAutocomplete
              defaultStreet={client?.location_street}
              defaultCity={client?.location_city ?? crafted?.city}
              defaultCounty={client?.location_county ?? crafted?.county}
              defaultState={client?.location_state ?? crafted?.state}
              defaultZip={client?.location_zip ?? crafted?.zip}
              defaultLine={crafted?.address}
            />
          </section>

          <section className="space-y-4">
            <SectionTitle>Mission &amp; current programs</SectionTitle>
            <MissionField c={narrative} help="What the organization does and who it exists to serve." />
            <ProgramsSection
              c={narrative}
              status="existing"
              title="Programs they run today"
              help="Programs already operating. What each does and who it serves."
              addLabel="+ Add existing program"
              // A crafted site often yields many existing programs; folded by default
              // so they don't bury the rest of this step.
              collapsible
            />
          </section>
        </div>
      )}

      {/* ── Step 3: what they need funded ───────────────────────────────────── */}
      {mounted(2) && (
        <div className={stepClass(2)}>
          <section className="space-y-4">
            <SectionTitle>What you need funded</SectionTitle>
            <FundingNeedField
              c={narrative}
              label="What are you looking to fund?"
              help="A sentence or two on the funding they're after — a program, staffing, equipment, a capital project. This is a primary matching signal."
            />
            <ProgramsSection
              c={narrative}
              status="prospective"
              title="New / planned programs seeking funding"
              help="Programs they want to launch or expand with grant funding (not yet operating)."
              addLabel="+ Add planned program"
            />
            <PriorityAreasSection
              c={narrative}
              help="Used to highlight and filter in their grant report. A strong match still surfaces even if it falls outside these."
            />
          </section>
        </div>
      )}

      {/* ── Step 4: partnerships (clients only) ─────────────────────────────── */}
      {hasStep("partnerships") && mounted(3) && (
        <div className={stepClass(3)}>
          <section className="space-y-4">
            <SectionTitle>Partnerships</SectionTitle>
            <p className="text-xs text-muted-foreground">
              Anything that could strengthen an application: formal partners (MOUs, consortium members,
              subrecipients), informal relationships that could become one, likely letters of support,
              in-kind or cash contributors, and fiscal sponsors. Name the organization and what the
              relationship actually provides.
            </p>
            <PartnersSection
              c={narrative}
              help="One entry per organization. What they bring matters more than the label."
            />
          </section>
        </div>
      )}

      {/* ── Step 5: anything else (clients only) ────────────────────────────── */}
      {hasStep("anything") && mounted(4) && (
        <div className={stepClass(4)}>
          <section className="space-y-4">
            <SectionTitle>Anything else we should know?</SectionTitle>
            <AdditionalInfoField
              c={narrative}
              help="Constraints, timing, history with funders, internal capacity — anything that shapes what's realistic."
            />
          </section>
        </div>
      )}

      {/* ── Step 6: engagement (CLIENTS ONLY; staff-facing) ─────────────────── */}
      {isClient && mounted(5) && (
        <div className={stepClass(5)}>
          <section className="space-y-4">
            <SectionTitle>
              Engagement <span className="font-normal normal-case text-muted-foreground">(optional)</span>
            </SectionTitle>
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
            <label className="flex items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                name="account_managed"
                value="true"
                defaultChecked={!!client?.account_managed}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Account-managed (premium)</span>
                <span className="block text-xs text-muted-foreground">
                  An account manager reviews and releases each match before the client sees it. Off by
                  default — the client goes straight to their own Grant Alerts / Grant Report.
                </span>
              </span>
            </label>
          </section>
        </div>
      )}

      {/* ── EDIT ONLY: the admin-only matcher-facing fields. Deliberately absent
          from intake -- budget / RUCC / EIN are auto-pulled and confirmed after the
          record exists, not typed during onboarding. ─────────────────────────── */}
      {isEdit && isClient && (
        <>
          <section className="space-y-4">
            <SectionTitle>
              Grant-matching profile{" "}
              <span className="font-normal normal-case text-muted-foreground">(optional)</span>
            </SectionTitle>
            <p className="text-xs text-muted-foreground">
              Recorded for matching context — these flag and cite, they never hide a grant. Budget and
              RUCC auto-fill from the IRS 990 and the USDA county crosswalk.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Match / cost-share capacity" name="match_cost_share_capacity" defaultValue={client?.match_cost_share_capacity} />
              <Field label="Annual budget" name="annual_budget" defaultValue={client?.annual_budget} />
              <Field label="RUCC codes" name="rucc_codes" defaultValue={client?.rucc_codes} />
              <Field label="IRS EIN" name="ein" defaultValue={client?.ein} placeholder="e.g. 71-0236875 — pulls annual budget from the IRS 990" />
            </div>
            {client?.nonprofit_finance?.verified && client.nonprofit_finance.total_revenue != null && (
              <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Latest IRS 990</span>
                {client.nonprofit_finance.fiscal_year ? ` (FY${client.nonprofit_finance.fiscal_year})` : ""}: total revenue{" "}
                ${client.nonprofit_finance.total_revenue.toLocaleString("en-US")}
                {client.nonprofit_finance.total_expenses != null &&
                  `, expenses $${client.nonprofit_finance.total_expenses.toLocaleString("en-US")}`}
                {" "}— pulled from ProPublica. Citation only; not used to gate matching.
              </p>
            )}
            <ChipInput
              name="service_area"
              label="Service area"
              defaultValue={client?.service_area ?? undefined}
              placeholder="Type a county or region, press Enter"
            />
          </section>

          <section className="space-y-2">
            <Label htmlFor="matching_rules">Note to the matcher (optional)</Label>
            <textarea
              id="matching_rules"
              name="matching_rules"
              defaultValue={client?.matching_rules ?? undefined}
              rows={4}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder={'Authoritative guidance the model applies. e.g. "Only pursue rural health grants." / "Never recommend as prime on research-heavy programs."'}
            />
            <p className="text-xs text-muted-foreground">Read by the model as authoritative guidance for this client.</p>
          </section>
        </>
      )}

      {/* Preserved-but-not-shown. parse() writes every column it reads, so a field
          absent from the DOM would NULL the stored value. On CREATE that also carries
          the crafted EIN / service area forward (they're confirmed later, in the
          post-create enrichment step, rather than typed during intake). */}
      <input type="hidden" name="next_step" value={client?.next_step ?? ""} readOnly />
      <input type="hidden" name="notes" value={client?.notes ?? ""} readOnly />
      <input type="hidden" name="project_stage" value={client?.project_stage ?? ""} readOnly />
      <input type="hidden" name="hard_constraints" value={JSON.stringify(client?.hard_constraints ?? [])} readOnly />
      <input type="hidden" name="known_constraints" value={client?.known_constraints ?? ""} readOnly />
      {!isEdit && (
        <>
          <input type="hidden" name="ein" value={crafted?.ein ?? ""} readOnly />
          <input type="hidden" name="service_area" value={JSON.stringify(crafted?.service_area ?? [])} readOnly />
          <input type="hidden" name="annual_budget" value="" readOnly />
          <input type="hidden" name="rucc_codes" value="" readOnly />
          <input type="hidden" name="match_cost_share_capacity" value="" readOnly />
          <input type="hidden" name="matching_rules" value="" readOnly />
        </>
      )}
      {/* A prospect never reaches the engagement step, so its fields are absent --
          the server forces prospect-safe values regardless, but carry the stored
          engagement through on an EDIT so a prospect edit can't wipe it. */}
      {!isClient && isEdit && (
        <>
          <input type="hidden" name="engagement_tier" value={client?.engagement_tier ?? ""} readOnly />
          <input type="hidden" name="retainer_hours" value={String(client?.retainer_hours ?? 0)} readOnly />
          <input type="hidden" name="contract_start" value={client?.contract_start ?? ""} readOnly />
          <input type="hidden" name="contract_end" value={client?.contract_end ?? ""} readOnly />
        </>
      )}

      {stepError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200"
        >
          {stepError}
        </div>
      )}

      {formError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200"
        >
          {formError}
        </div>
      )}

      {/* Navigation. Wizard: Back / Next, with Save only on the last step so a
          half-filled intake can't be submitted early. Edit: a single Save. */}
      {isEdit ? (
        <div className="flex gap-3">
          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? "Saving…" : submitLabel}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {step > 0 && (
            <Button type="button" variant="ghost" onClick={goBack} disabled={submitting}>
              Back
            </Button>
          )}
          {/* DISTINCT KEYS ARE LOAD-BEARING. Without them these two occupy the same
              slot, so React patches `type` on the SAME DOM node instead of replacing
              it -- and because React flushes click handlers synchronously, the node
              had already become type="submit" by the time the browser performed the
              click's default action. Clicking "Next" INTO the last step therefore
              submitted the form in that same click, skipping the last page entirely.
              Separate keys make React swap the node, so the in-flight click has no
              submit button to act on. handleSubmit also guards on step. */}
          {step < lastStep ? (
            <Button key="wizard-next" type="button" onClick={goNext} disabled={crafting}>
              Next
            </Button>
          ) : (
            <Button key="wizard-save" type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "Saving…" : submitLabel}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {step < lastStep ? "Nothing saves until the last step." : "This creates the record and starts enrichment."}
          </span>
        </div>
      )}
    </form>
  );
}
