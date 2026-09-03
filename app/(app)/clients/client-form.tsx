"use client";

import { useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChipInput } from "@/components/ui/chip-input";
import { AddressAutocomplete } from "@/components/clients/address-autocomplete";
import { CreateTransition } from "@/components/clients/create-transition";
import { StepNav } from "@/components/clients/step-nav";
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
 * The create/edit form for a client OR a prospect. BOTH are stepped -- same pages,
 * same fields -- but they are navigated differently, because they are different jobs:
 *
 *  - CREATE -> a guided WIZARD (Back / Next). Step 1 is the website + "Craft profile";
 *    the rest is the crafted profile broken into digestible pages. The order is real:
 *    nothing saves until the last page, and a step must not mount before the craft has
 *    landed.
 *  - EDIT   -> the same pages, but navigated by CLICKING the section in the bar at the
 *    top. Editing is "change the one thing I came here for", so there is no order to
 *    walk and no reason to make you walk it. Edit adds the pages intake has no business
 *    asking for: engagement terms, the grant-matching profile + matcher note, and (via
 *    `extras`) the read-only panes that used to be separate routes and buttons.
 *
 * Two constraints shape the stepping in both modes:
 *  1. Steps are MOUNTED ONCE REACHED (edit: always) and then hidden with CSS, never
 *     unmounted -- an unmounted input is dropped from FormData, which would silently
 *     discard a completed page on submit. This is why saving from ANY section in edit
 *     mode writes the whole profile rather than nulling the panes you weren't looking
 *     at.
 *  2. Non-narrative fields are uncontrolled (defaultValue), so on CREATE a step must
 *     not mount until the craft has landed or its crafted prefill would be missed. The
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
  extras = [],
  initialSection,
}: {
  client?: Client;
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  submitLabel: string;
  defaultKind?: "client" | "prospect";
  // EDIT ONLY. Extra panes that appear in the same section bar but are NOT part of
  // this form -- the API-data view and the client-admin rail. They are rendered as
  // siblings of the <form>, never inside it: both contain their own <form> elements
  // (portal seats, delete), and a nested form is dropped by the browser, which would
  // reattach those submit buttons to this one.
  extras?: { key: string; title: string; short?: string; node: React.ReactNode }[];
  // Which section to open on. Lets a link elsewhere point AT a section
  // (?section=api) now that these are panes rather than routes.
  initialSection?: string;
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

  // A PROSPECT intake stays deliberately light: website -> general -> needs. The
  // partnership / anything-else / engagement depth is for a signed client, not an
  // outreach target. Their narrative keys still round-trip through the hidden input
  // (empty), so nothing is dropped if a prospect is later promoted.
  //
  // EDIT adds what intake has no business asking for during onboarding: the engagement
  // terms (set on their own post-create step, step 7) and the grant-matching profile
  // (budget / RUCC / EIN are auto-pulled and confirmed, never typed).
  const steps: { key: string; title: string; short?: string }[] = [
    { key: "start", title: "Website" },
    { key: "general", title: "General information", short: "General" },
    { key: "needs", title: "What you need funded", short: "Funding needs" },
    ...(isClient
      ? [
          { key: "partnerships", title: "Partnerships" },
          { key: "anything", title: "Anything else" },
        ]
      : []),
    ...(isEdit && isClient
      ? [
          { key: "engagement", title: "Engagement" },
          { key: "matching", title: "Grant-matching profile", short: "Matching" },
        ]
      : []),
  ];
  const lastStep = steps.length - 1;
  // Every navigable pane, form steps first. Extras only exist on edit.
  const panes = [...steps, ...(isEdit ? extras : [])];

  // Position. `maxStep` is the create wizard's high-water mark: every step up to it
  // stays mounted (hidden) so its values survive navigation. Edit mounts everything.
  const [step, setStep] = useState(() => {
    if (!isEdit || !initialSection) return 0;
    const i = panes.findIndex((p) => p.key === initialSection);
    return i >= 0 ? i : 0;
  });
  const [maxStep, setMaxStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  // Where to send you back to when you have unsaved edits and are looking at a pane
  // that has no Save button of its own.
  const [lastFormStep, setLastFormStep] = useState(0);
  // Any real edit to the form, so an extra pane can say so rather than leaving you
  // staring at a section with no Save button and no idea your typing is still pending.
  const [dirty, setDirty] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Steps continue past this form on CREATE: 6 = the data-pull confirm, 7 = engagement
  // (both post-create, on their own routes). A prospect stops at the data-pull confirm.
  const totalSteps = steps.length + (isClient ? 2 : 1);
  // On edit, the extras are panes rather than form steps -- the form itself is hidden
  // while one of them is showing.
  const onExtra = step >= steps.length;

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
    if (!isEdit && step !== lastStep) {
      // A stray implicit submit (Enter on a single-field wizard step) still fires the native submit
      // that disarms FormExitGuard. Re-arm before bailing, or backing out afterward would silently
      // drop the in-progress wizard work -- the same drop item 2a's re-arm exists to prevent.
      reArmDirty();
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setDirty(false);
    // A successful create ends in redirect(): the server action resolves, the framework
    // navigates, and this component unmounts -- so `submitting` stays true through the redirect
    // (that is what keeps the "Saving…" screen up). The bug this try/catch fixes is the OTHER
    // exit: if the action THROWS (a DB blip, an unexpected 500) instead of returning {error}, the
    // await rejected and nothing reset `submitting` -- the "Saving the client" screen hung forever
    // with the work neither saved nor recoverable on screen. Now a throw resets it and surfaces an
    // error the reader can retry from. (A redirect does NOT throw on the client, so success is
    // unaffected.)
    try {
      const result = await action(formData);
      if (result?.error) {
        setFormError(result.error);
        setSubmitting(false);
        reArmDirty();
      }
    } catch {
      setFormError(
        isEdit
          ? "Couldn't save your changes. Please try again."
          : "Couldn't save the record — it may not have been created. Please try again.",
      );
      setSubmitting(false);
      reArmDirty();
    }
  }

  // A FAILED save leaves the reader on the form with unsaved work, but the native `submit` already
  // fired and DISARMED the exit guard (FormExitGuard listens on this same <form> element and drops
  // its dirty bit on submit so a successful redirect isn't interrupted). Without re-arming here, a
  // reader who sees the error and immediately clicks Back or closes the tab -- without typing again
  // first -- loses the work silently, the exact drop item 2a exists to prevent. Restore this form's
  // own dirty flag AND dispatch a synthetic input event so the separate guard re-arms through the
  // same channel a keystroke uses (it re-arms on `input`), rather than waiting for the next edit.
  function reArmDirty() {
    setDirty(true);
    formRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
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
  // Edit's clickable nav. No gate: there is no order to enforce when the record
  // already exists, and every pane is mounted regardless of which one is showing.
  function selectPane(i: number) {
    setStepError(null);
    setStep(i);
    setMaxStep((m) => Math.max(m, i));
    if (i < steps.length) setLastFormStep(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Panes are addressed by KEY, not by a hard-coded index -- the step list differs by
  // kind AND by mode, so a numeric index silently pointed at the wrong pane the moment
  // either list changed.
  const indexOf = (key: string) => steps.findIndex((s) => s.key === key);
  // Edit mounts every pane; create mounts a step once it has been reached. Either way
  // a mounted pane is only HIDDEN, never unmounted, so its inputs stay in FormData.
  const isMounted = (key: string) => {
    const i = indexOf(key);
    return i >= 0 && (isEdit || i <= maxStep);
  };
  const paneClass = (key: string) => (indexOf(key) === step ? "space-y-8" : "hidden");

  return (
    <div className="max-w-3xl space-y-8">
      {/* EDIT: the section bar IS the navigation. Rendered outside the <form> so the
          extra panes (which contain their own forms) can be its siblings. */}
      {isEdit && (
        <div className="space-y-3">
          <StepNav
            steps={panes.map((p) => ({ key: p.key, short: p.short ?? p.title }))}
            active={step}
            onSelect={selectPane}
            label={`Editing ${kindLabel}`}
          />
          {!isClient && (
            <p className="text-xs text-muted-foreground">
              Staff-only — no client login, no daily matching (matched on demand).
            </p>
          )}
          {/* An extra pane has no Save of its own, and the form is hidden while it
              shows. Say so rather than letting typed edits sit invisibly pending. */}
          {onExtra && dirty && (
            <p
              role="alert"
              className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200"
            >
              You have unsaved profile edits.{" "}
              <button type="button" onClick={() => selectPane(lastFormStep)} className="underline">
                Go back and save them
              </button>
              .
            </p>
          )}
        </div>
      )}

      {/* noValidate ALWAYS. Steps are hidden with CSS while still mounted, and the
          browser refuses to submit a form containing an invalid control it cannot focus
          (e.g. a malformed primary_contact_email on an off-screen step) -- it aborts
          with a console warning and NO visible error, so the Save button just appears
          dead. Validation is the server's job here; the one hard requirement (name) is
          caught by goNext while its step is on screen. This used to be wizard-only,
          when edit rendered every field at once; edit is stepped now, so it needs it
          for exactly the same reason. */}
      <form
        ref={formRef}
        action={handleSubmit}
        noValidate
        onChange={() => setDirty(true)}
        className={onExtra ? "hidden" : "space-y-8"}
      >
        {submitting && !isEdit && <CreateTransition kindLabel={kindLabel} />}

        <input type="hidden" name="kind" value={kind} />
        {/* Mounted exactly once for the whole form -- carries the entire narrative. */}
        <NarrativeHiddenInput c={narrative} />

        {/* Create's progress read-out. Not clickable: the wizard's order is real. */}
        {!isEdit && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-wide">
                Step {step + 1} of {totalSteps} · {steps[step].title}
              </span>
              <span>New {kindLabel}</span>
            </div>
            <div className="flex gap-1.5">
              {Array.from({ length: totalSteps }, (_, i) => (
                <span
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    i <= step ? "bg-brand-orange" : "bg-brand-navy/10"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {craftNote && (
          <p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {craftNote}
          </p>
        )}

        {/* ── Step 1: website + craft ─────────────────────────────────────────── */}
        <div className={paneClass("start")}>
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
        {isMounted("general") && (
          <div className={paneClass("general")}>
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
                      Off by default. GRANTED excludes research funders (e.g. NIH) from the forecast horizon.
                      Check this only if this organization pursues federal research grants.
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
        {isMounted("needs") && (
          <div className={paneClass("needs")}>
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
        {isMounted("partnerships") && (
          <div className={paneClass("partnerships")}>
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
        {isMounted("anything") && (
          <div className={paneClass("anything")}>
            <section className="space-y-4">
              <SectionTitle>Anything else we should know?</SectionTitle>
              <AdditionalInfoField
                c={narrative}
                help="Constraints, timing, history with funders, internal capacity — anything that shapes what's realistic."
              />
            </section>
          </div>
        )}

        {/* ── EDIT ONLY: engagement terms. On CREATE these are set after the record
            exists (step 7, /finish), so the data pull can be reviewed first. ───── */}
        {isMounted("engagement") && (
          <div className={paneClass("engagement")}>
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

        {/* ── EDIT ONLY: the matcher-facing fields. Deliberately absent from intake --
            budget / RUCC / EIN are auto-pulled and confirmed after the record exists,
            not typed during onboarding. ───────────────────────────────────────── */}
        {isMounted("matching") && (
          <div className={paneClass("matching")}>
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
          </div>
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
        {/* A prospect has no engagement step in either mode, so its fields are absent --
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
            half-filled intake can't be submitted early. Edit: a single Save, on every
            section -- every field is still mounted, so one Save writes the whole
            profile no matter which section you happen to be looking at. */}
        {isEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "Saving…" : submitLabel}
            </Button>
            <span className="text-xs text-muted-foreground">
              Saves every section, not just this one.
            </span>
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
              // Reads "Next", not the create label: two steps still follow this one, so
              // naming the write here implied the intake ended at page 5.
              <Button key="wizard-save" type="submit" disabled={submitting} aria-busy={submitting}>
                {submitting ? "Saving…" : "Next"}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {step < lastStep
                ? "Nothing saves until you finish these pages."
                : "Saves the record and starts the data pulls — two steps left."}
            </span>
          </div>
        )}
      </form>

      {/* EDIT extras: panes that share the section bar but are not part of the form.
          Mounted alongside it, hidden with CSS, so switching sections never remounts
          (and never re-fetches) them. */}
      {isEdit &&
        extras.map((x, i) => (
          <div key={x.key} className={step === steps.length + i ? "space-y-6" : "hidden"}>
            {x.node}
          </div>
        ))}
    </div>
  );
}
