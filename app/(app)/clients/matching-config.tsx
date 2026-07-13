"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { HardConstraint, ConstraintType } from "@/types/database";

// Admin-only editor for the two highest-leverage matcher fields that were
// previously editable nowhere: matching_rules (free-text authoritative overrides
// the model reads) and hard_constraints (code-enforced gates). A guided picker,
// never a raw JSON box: `action` is derived server-side from type, role_ceiling
// is a fixed dropdown (a free-text ceiling silently never fires), and the effect
// of each type is shown read-only so the human sees the consequence. The server
// action re-validates and REJECTS a malformed constraint on save.

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

const CONSTRAINT_TYPES: {
  value: ConstraintType;
  label: string;
  effect: string;
  valueLabel: string;
  valuePlaceholder: string;
}[] = [
  {
    value: "ineligible_funder",
    label: "Ineligible funder",
    effect: "Excludes every grant from this funder before any scoring (hard, pre-model).",
    valueLabel: "Funder name (or substring)",
    valuePlaceholder: "e.g. Department of Defense",
  },
  {
    value: "role_ceiling",
    label: "Role ceiling",
    effect: "Caps this client's role at the selected level and limits the fit score to 2.",
    valueLabel: "Maximum role",
    valuePlaceholder: "",
  },
  {
    value: "ineligible_partner",
    label: "Ineligible partner",
    effect:
      "Blocks this org as the recommended prime and flags the outreach to verify it is not named in the email.",
    valueLabel: "Partner org name",
    valuePlaceholder: "e.g. Acme University",
  },
  {
    value: "entity_screen",
    label: "Entity screen",
    effect: "Adds a reviewer flag to confirm before approving. No automatic block.",
    valueLabel: "Screen subject / label",
    valuePlaceholder: "e.g. 501(c)(4) lobbying limit",
  },
];

// Must match ROLE_CEILING_VALUES in lib/grants/constraints.ts.
const ROLE_CEILING_OPTIONS = [
  "prime",
  "co-applicant",
  "sub",
  "named collaborator",
  "letter of support",
  "facilitator",
  "not recommended",
];

type Row = { type: ConstraintType; value: string; scope: string; note: string };

function toRow(c: HardConstraint): Row {
  return { type: c.type, value: c.value, scope: c.scope ?? "", note: c.note };
}

export function MatchingConfig({
  defaultConstraints = [],
  defaultMatchingRules,
  defaultKnownConstraints,
}: {
  defaultConstraints?: HardConstraint[];
  defaultMatchingRules?: string | null;
  defaultKnownConstraints?: string | null;
}) {
  const [rows, setRows] = useState<Row[]>(defaultConstraints.map(toRow));

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () =>
    setRows((rs) => [...rs, { type: "ineligible_funder", value: "", scope: "", note: "" }]);
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  // Serialize for the server action. `action` is derived server-side from type,
  // so it is deliberately NOT sent. Blank rows (no value and no note) are dropped
  // so an accidental "Add" that is left empty does not fail the save.
  const serialized = JSON.stringify(
    rows
      .filter((r) => r.value.trim() || r.note.trim())
      .map((r) => ({
        type: r.type,
        value: r.value.trim(),
        note: r.note.trim(),
        ...(r.type === "role_ceiling" && r.scope.trim() ? { scope: r.scope.trim() } : {}),
      })),
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Matcher controls
        </h2>
        <p className="text-xs text-muted-foreground">
          Admin-only. How the matcher is constrained for this client, strongest first: hard
          constraints are enforced in code; matching rules are authoritative guidance the model
          applies; advisory constraints are context the model weighs. An invalid hard constraint is
          rejected on save (never silently ignored).
        </p>
      </div>

      <div className="space-y-3">
        <Label>1. Hard constraints (code-enforced gates)</Label>
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No hard constraints. Most clients need none.</p>
        )}
        {rows.map((r, i) => {
          const meta = CONSTRAINT_TYPES.find((t) => t.value === r.type)!;
          return (
            <div key={i} className="space-y-3 rounded-lg border border-input p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <select
                    value={r.type}
                    onChange={(e) =>
                      // Reset value on type change: a role dropdown value is not a
                      // valid funder/partner string and vice versa.
                      update(i, { type: e.target.value as ConstraintType, value: "" })
                    }
                    className={SELECT_CLASS}
                  >
                    {CONSTRAINT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>{meta.valueLabel}</Label>
                  {r.type === "role_ceiling" ? (
                    <select
                      value={r.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                      className={SELECT_CLASS}
                    >
                      <option value="">—</option>
                      {ROLE_CEILING_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={r.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                      placeholder={meta.valuePlaceholder}
                    />
                  )}
                </div>
              </div>

              {r.type === "role_ceiling" && (
                <div className="space-y-2">
                  <Label>Scope (optional)</Label>
                  <Input
                    value={r.scope}
                    onChange={(e) => update(i, { scope: e.target.value })}
                    placeholder="e.g. research-heavy: R34, K12"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to cap on every grant. A scope is best-effort keyword matching on
                    grant text, so a scoped ceiling always also flags the reviewer.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>Note (required)</Label>
                <Input
                  value={r.note}
                  onChange={(e) => update(i, { note: e.target.value })}
                  placeholder="Why this constraint exists — shown to the reviewer and the model."
                />
              </div>

              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Effect:</span> {meta.effect}
              </p>

              <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
                Remove
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={add}>
          Add constraint
        </Button>
      </div>

      <input type="hidden" name="hard_constraints" value={serialized} />

      <div className="space-y-2">
        <Label htmlFor="matching_rules">2. Matching rules (authoritative overrides)</Label>
        <textarea
          id="matching_rules"
          name="matching_rules"
          defaultValue={defaultMatchingRules ?? undefined}
          rows={4}
          className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder={
            'Free-text the model applies before general logic. e.g. "Only pursue rural health grants." / "Never recommend as prime on research-heavy programs."'
          }
        />
        <p className="text-xs text-muted-foreground">
          Read by the model as authoritative guidance. For a hard legal/eligibility gate, use a hard
          constraint above instead — those are enforced in code, not left to the model.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="known_constraints">3. Advisory constraints / context</Label>
        <textarea
          id="known_constraints"
          name="known_constraints"
          defaultValue={defaultKnownConstraints ?? undefined}
          rows={3}
          className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder={'e.g. "Limited grant-writing capacity" / "Board wary of federal reporting burden."'}
        />
        <p className="text-xs text-muted-foreground">
          Context the matcher weighs but does not treat as a hard rule.
        </p>
      </div>
    </section>
  );
}
