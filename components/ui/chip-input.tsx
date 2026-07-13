"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";

// Chip / tag input: type a value, press Enter (or comma) to commit it as a chip,
// box clears for the next. No autocomplete / geo-API. Self-contained (like
// NarrativeFields / MatchingConfig): owns its state and emits ONE hidden input
// (`name`) carrying the chips as a JSON array. The admin's native <form action>
// captures it via FormData; the public fetch form reads it via querySelector.
// Server parses it with parseChipList (lib/intake/narrative).
export function ChipInput({
  name,
  label,
  defaultValue,
  placeholder,
}: {
  name: string;
  label?: string;
  defaultValue?: string[];
  placeholder?: string;
}) {
  const [chips, setChips] = useState<string[]>(defaultValue ?? []);
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (v && !chips.includes(v)) setChips([...chips, v]);
    setDraft("");
  };
  const remove = (i: number) => setChips(chips.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      {/* One hidden field carries the chips as JSON (robust to commas in a value). */}
      <input type="hidden" name={name} value={JSON.stringify(chips)} readOnly />
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((c, i) => (
            <span
              key={`${c}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-input bg-card px-3 py-1 text-sm"
            >
              {c}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${c}`}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder}
      />
    </div>
  );
}
