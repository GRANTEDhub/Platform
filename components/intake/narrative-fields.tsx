"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PRIORITY_AREAS } from "@/lib/intake/fields";
import { EMPTY_NARRATIVE, type NarrativeIntake, type NarrativeProgram } from "@/lib/intake/narrative";

// Shared narrative-capture block, mounted in BOTH the public intake form and the
// admin client create/edit form. Self-contained (like MatchingConfig): it owns its
// state and emits a single hidden input `intake_narrative` (JSON). The admin's
// native <form action> captures it via FormData; the public form reads it at
// submit via querySelector (the same way it reads the Turnstile token). Occupancy-
// facing / matcher-config fields (hard_constraints, matching_rules, engagement_tier,
// budget/RUCC/match/service_area) deliberately live OUTSIDE this component.

const FIELD = "flex h-11 w-full rounded-md border border-input bg-white px-3 py-2 text-sm";
const AREA = "flex w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-relaxed";

export function NarrativeFields({
  defaultValue,
  fundingNeedRequired,
}: {
  defaultValue?: NarrativeIntake;
  fundingNeedRequired?: boolean;
}) {
  const [n, setN] = useState<NarrativeIntake>(defaultValue ?? EMPTY_NARRATIVE);

  const set = <K extends keyof NarrativeIntake>(k: K, v: NarrativeIntake[K]) =>
    setN((prev) => ({ ...prev, [k]: v }));

  const toggleArea = (a: string) =>
    set(
      "priority_areas",
      n.priority_areas.includes(a)
        ? n.priority_areas.filter((x) => x !== a)
        : [...n.priority_areas, a],
    );

  const setProgram = (i: number, patch: Partial<NarrativeProgram>) =>
    set("programs", n.programs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const addProgram = () =>
    set("programs", [...n.programs, { name: "", description: "", serves: "", status: "existing" }]);
  const removeProgram = (i: number) =>
    set("programs", n.programs.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-6">
      {/* One hidden field carries the whole narrative: FormData (admin) reads it
          directly; the public fetch submit reads it via querySelector. */}
      <input type="hidden" name="intake_narrative" value={JSON.stringify(n)} readOnly />

      <Field label="What are you looking for?" required={fundingNeedRequired}>
        <textarea
          className={AREA}
          rows={4}
          maxLength={2000}
          required={fundingNeedRequired}
          value={n.funding_need}
          onChange={(e) => set("funding_need", e.target.value)}
          placeholder="A sentence or two on what you're hoping to fund — a program, staffing, equipment, a project…"
        />
      </Field>

      <Field label="Mission">
        <textarea
          className={AREA}
          rows={3}
          maxLength={2000}
          value={n.mission}
          onChange={(e) => set("mission", e.target.value)}
          placeholder="Your organization's mission and who you exist to serve."
        />
      </Field>

      <div>
        <Label>Programs</Label>
        <p className="mt-1 text-xs text-neutral-500">
          Each program: what it does and who it serves. Mark existing vs. planned.
        </p>
        <div className="mt-2 space-y-4">
          {n.programs.map((p, i) => (
            <div key={i} className="space-y-2 rounded-md border border-input p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[12rem] flex-1"
                  placeholder="Program name"
                  value={p.name}
                  onChange={(e) => setProgram(i, { name: e.target.value })}
                />
                <select
                  className={`${FIELD} w-40`}
                  value={p.status}
                  onChange={(e) =>
                    setProgram(i, { status: e.target.value as NarrativeProgram["status"] })
                  }
                >
                  <option value="existing">Existing</option>
                  <option value="prospective">Prospective</option>
                </select>
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
            + Add program
          </Button>
        </div>
      </div>

      <div>
        <Label>Priority funding areas</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {PRIORITY_AREAS.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={n.priority_areas.includes(a)}
                onChange={() => toggleArea(a)}
              />
              {a}
            </label>
          ))}
        </div>
      </div>

      <Field label="Partnerships">
        <textarea
          className={AREA}
          rows={3}
          maxLength={2000}
          value={n.partnerships}
          onChange={(e) => set("partnerships", e.target.value)}
          placeholder="Key partners and the nature of each relationship."
        />
      </Field>

      <Field label="Anything else we should know?">
        <textarea
          className={AREA}
          rows={3}
          maxLength={2000}
          value={n.additional_info}
          onChange={(e) => set("additional_info", e.target.value)}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
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
