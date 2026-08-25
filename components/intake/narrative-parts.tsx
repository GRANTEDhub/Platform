"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PRIORITY_AREAS } from "@/lib/intake/fields";
import {
  EMPTY_NARRATIVE,
  type NarrativeIntake,
  type NarrativeProgram,
  type NarrativePartner,
} from "@/lib/intake/narrative";

// The narrative capture, broken into a state controller + individually placeable
// sections.
//
// WHY: the narrative used to live entirely inside NarrativeFields, which owned its
// own state and emitted the single `intake_narrative` hidden input. That is exactly
// right for a one-page form, but the multi-step intake wizard needs the SAME state
// spread across several pages (mission on one, funding need on another, partners on
// their own). Mounting the component more than once would emit conflicting hidden
// inputs, so the state is lifted into useNarrative() and the pieces are exported as
// sections that share one controller.
//
// NarrativeFields (the one-page form: public intake + the client edit page) is now a
// thin composition of these parts, with its public props unchanged.

const FIELD = "flex h-11 w-full rounded-md border border-input bg-white px-3 py-2 text-sm";
const AREA = "flex w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-relaxed";

export type NarrativeController = {
  n: NarrativeIntake;
  set: <K extends keyof NarrativeIntake>(k: K, v: NarrativeIntake[K]) => void;
  patch: (p: Partial<NarrativeIntake>) => void;
};

export function useNarrative(defaultValue?: NarrativeIntake): NarrativeController {
  const [n, setN] = useState<NarrativeIntake>(defaultValue ?? EMPTY_NARRATIVE);
  return {
    n,
    set: (k, v) => setN((prev) => ({ ...prev, [k]: v })),
    patch: (p) => setN((prev) => ({ ...prev, ...p })),
  };
}

// The single field that carries the whole narrative to the server. Mount EXACTLY
// once per form: FormData (admin) reads it directly; the public fetch submit reads
// it via querySelector.
export function NarrativeHiddenInput({ c }: { c: NarrativeController }) {
  return <input type="hidden" name="intake_narrative" value={JSON.stringify(c.n)} readOnly />;
}

export function NarrativeField({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="ml-0.5 text-brand-orange">*</span>}
      </Label>
      {help && <p className="text-xs text-neutral-500">{help}</p>}
      {children}
    </div>
  );
}

export function FundingNeedField({
  c,
  required,
  label = "What are you looking for?",
  help,
}: {
  c: NarrativeController;
  required?: boolean;
  label?: string;
  help?: string;
}) {
  return (
    <NarrativeField label={label} required={required} help={help}>
      <textarea
        className={AREA}
        rows={4}
        maxLength={2000}
        required={required}
        value={c.n.funding_need}
        onChange={(e) => c.set("funding_need", e.target.value)}
        placeholder="A sentence or two on what you're hoping to fund — a program, staffing, equipment, a project…"
      />
    </NarrativeField>
  );
}

export function MissionField({ c, help }: { c: NarrativeController; help?: string }) {
  return (
    <NarrativeField label="Mission" help={help}>
      <textarea
        className={AREA}
        rows={3}
        maxLength={2000}
        value={c.n.mission}
        onChange={(e) => c.set("mission", e.target.value)}
        placeholder="Your organization's mission and who you exist to serve."
      />
    </NarrativeField>
  );
}

// Programs, optionally scoped to ONE status so the wizard can put existing programs
// ("what you run today") and prospective ones ("what you want funded") on separate
// pages. Entries are filtered for display but edited THROUGH their real index in the
// full list, so the other status's entries are never disturbed.
export function ProgramsSection({
  c,
  status,
  title = "Programs",
  help = "Each program: what it does and who it serves. Mark existing vs. planned.",
  addLabel = "+ Add program",
  collapsible = false,
}: {
  c: NarrativeController;
  status?: NarrativeProgram["status"];
  title?: string;
  help?: string;
  addLabel?: string;
  // Start folded behind a count. A crafted profile can carry a dozen programs, which
  // buries the rest of the step under boilerplate the reviewer usually just accepts.
  // Only collapses when there is something to collapse -- an empty list stays open so
  // the Add button is reachable without an extra click.
  collapsible?: boolean;
}) {
  const rows = c.n.programs
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (status ? p.status === status : true));
  const foldable = collapsible && rows.length > 0;
  const [open, setOpen] = useState(!foldable);

  const setProgram = (i: number, patch: Partial<NarrativeProgram>) =>
    c.set("programs", c.n.programs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const addProgram = () =>
    c.set("programs", [
      ...c.n.programs,
      { name: "", description: "", serves: "", status: status ?? "existing" },
    ]);
  const removeProgram = (i: number) =>
    c.set("programs", c.n.programs.filter((_, idx) => idx !== i));

  return (
    <div>
      {foldable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-left"
        >
          <span>
            <span className="text-sm font-medium text-brand-navy">{title}</span>
            <span className="ml-2 text-xs text-neutral-500">
              {rows.length} program{rows.length === 1 ? "" : "s"} identified
            </span>
          </span>
          <span aria-hidden="true" className="text-xs text-neutral-500">
            {open ? "Hide" : "Review / edit"}
          </span>
        </button>
      ) : (
        <>
          <Label>{title}</Label>
          <p className="mt-1 text-xs text-neutral-500">{help}</p>
        </>
      )}
      {/* Hidden with CSS, never unmounted: these are controlled inputs feeding the
          single narrative JSON, and a collapsed section must keep contributing. */}
      <div className={open ? "mt-2 space-y-4" : "hidden"}>
        {rows.map(({ p, i }) => (
          <div key={i} className="space-y-2 rounded-md border border-input p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[12rem] flex-1"
                placeholder="Program name"
                value={p.name}
                onChange={(e) => setProgram(i, { name: e.target.value })}
              />
              {/* The status picker is only meaningful when both kinds share one list.
                  On a status-scoped page the status is implied by the page itself. */}
              {!status && (
                <select
                  className={`${FIELD} w-40`}
                  value={p.status}
                  onChange={(e) => setProgram(i, { status: e.target.value as NarrativeProgram["status"] })}
                >
                  <option value="existing">Existing</option>
                  <option value="prospective">Prospective</option>
                </select>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => removeProgram(i)}>
                Remove
              </Button>
            </div>
            <textarea
              className={AREA}
              rows={2}
              maxLength={1000}
              placeholder="What the program does"
              value={p.description}
              onChange={(e) => setProgram(i, { description: e.target.value })}
            />
            <Input
              placeholder="Who it serves (populations / demographics)"
              value={p.serves}
              onChange={(e) => setProgram(i, { serves: e.target.value })}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addProgram}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

export function PriorityAreasSection({ c, help }: { c: NarrativeController; help?: string }) {
  const toggleArea = (a: string) =>
    c.set(
      "priority_areas",
      c.n.priority_areas.includes(a)
        ? c.n.priority_areas.filter((x) => x !== a)
        : [...c.n.priority_areas, a],
    );
  return (
    <div>
      <Label>Priority funding areas</Label>
      {help && <p className="mt-1 text-xs text-neutral-500">{help}</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {PRIORITY_AREAS.map((a) => (
          <label key={a} className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" checked={c.n.priority_areas.includes(a)} onChange={() => toggleArea(a)} />
            {a}
          </label>
        ))}
      </div>
    </div>
  );
}

export function PartnersSection({
  c,
  help = "Each partner: who they are and what the partnership provides.",
}: {
  c: NarrativeController;
  help?: string;
}) {
  // Editing structured partners makes them the source of truth, so clear the LEGACY
  // free-text `partnerships` in the SAME update (patch writes both keys atomically).
  // These forms never show a `partnerships` field, so a value loaded from the server
  // otherwise sits stale in state -- and parseNarrative's self-heal would resurrect a
  // removed partner from it on save while narrativeToIntakeData kept writing it back
  // into intake_data (where it still feeds the profile refiner).
  const setPartner = (i: number, patch: Partial<NarrativePartner>) =>
    c.patch({ partners: c.n.partners.map((p, idx) => (idx === i ? { ...p, ...patch } : p)), partnerships: "" });
  const addPartner = () =>
    c.patch({ partners: [...c.n.partners, { name: "", role: "" }], partnerships: "" });
  const removePartner = (i: number) =>
    c.patch({ partners: c.n.partners.filter((_, idx) => idx !== i), partnerships: "" });

  return (
    <div>
      <Label>Partnerships</Label>
      <p className="mt-1 text-xs text-neutral-500">{help}</p>
      <div className="mt-2 space-y-4">
        {c.n.partners.map((p, i) => (
          <div key={i} className="space-y-2 rounded-md border border-input p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[12rem] flex-1"
                placeholder="Partner organization"
                value={p.name}
                onChange={(e) => setPartner(i, { name: e.target.value })}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => removePartner(i)}>
                Remove
              </Button>
            </div>
            <textarea
              className={AREA}
              rows={2}
              maxLength={2000}
              placeholder="What the partnership entails (their role, what they bring)"
              value={p.role}
              onChange={(e) => setPartner(i, { role: e.target.value })}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addPartner}>
          + Add partner
        </Button>
      </div>
    </div>
  );
}

export function AdditionalInfoField({ c, help }: { c: NarrativeController; help?: string }) {
  return (
    <NarrativeField label="Anything else we should know?" help={help}>
      <textarea
        className={AREA}
        rows={3}
        maxLength={2000}
        value={c.n.additional_info}
        onChange={(e) => c.set("additional_info", e.target.value)}
      />
    </NarrativeField>
  );
}
