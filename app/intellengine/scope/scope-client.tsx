"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Paperclip, Pencil, Plus, Upload, X } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import type { ScopeSeed } from "@/lib/intellengine/prepopulate";

const SCOPE_WORD_LIMIT = 500;

type Partner = { name: string; role: string; description: string };

// Step 2 of 3 -- the interactive concept-proposal editor. Lets the client
// adjust the high-level shape (scope, role, partners, budget) before
// IntellEngine drafts the full section-by-section proposal, using the same
// design language as the rest of the flow.
//
// Initial values come from `seed` (built server-side in page.tsx via
// scopeSeedFrom): the released concept proposal the GRANTED team already scoped
// for this client + grant when available, else a light grant-derived hint, else
// blank for a from-scratch proposal. Everything stays fully editable.
//
// Editor state is still local -- persisting these edits back to the draft is the
// remaining follow-up (the intellengine_drafts row holds only structural progress
// today, per migration 0062). Uploaded files keep only the filename; nothing is
// stored yet, never implying the file was received.
export default function IntellEngineScopeClient({ draftId, seed }: { draftId?: string; seed: ScopeSeed }) {
  const [scope, setScope] = useState(seed.scope);
  const [role, setRole] = useState<"prime" | "partner">(seed.role);
  const [budget, setBudget] = useState(seed.budget);
  const [partners, setPartners] = useState<Partner[]>(seed.partners);
  const [draftPartner, setDraftPartner] = useState({ name: "", role: "", description: "" });
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Partner>({ name: "", role: "", description: "" });
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [partnerNote, setPartnerNote] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);

  const scopeWordCount = scope.trim().length ? scope.trim().split(/\s+/).length : 0;
  const overLimit = scopeWordCount > SCOPE_WORD_LIMIT;

  function addPartner() {
    if (!draftPartner.role.trim() && !draftPartner.description.trim()) {
      setPartnerNote("Add a role or description before adding this partner.");
      return;
    }
    setPartners([...partners, { ...draftPartner, name: draftPartner.name.trim() }]);
    setDraftPartner({ name: "", role: "", description: "" });
    setPartnerNote(null);
  }

  function startEdit(i: number) {
    setEditingIndex(i);
    setEditDraft(partners[i]);
    setEditNote(null);
  }

  function saveEdit() {
    if (editingIndex === null) return;
    if (!editDraft.role.trim() && !editDraft.description.trim()) {
      setEditNote("Add a role or description before saving.");
      return;
    }
    setPartners(partners.map((p, idx) => (idx === editingIndex ? { ...editDraft, name: editDraft.name.trim() } : p)));
    setEditingIndex(null);
  }

  // Cancels any open edit before mutating the list -- editingIndex is a plain
  // array index, so removing a partner above the one being edited would leave
  // it pointing at the wrong row (or silently vanish/reappear on the wrong
  // partner as the list changes size).
  function removePartner(i: number) {
    setPartners(partners.filter((_, idx) => idx !== i));
    setEditingIndex(null);
  }

  function addFiles(selected: FileList | null) {
    if (!selected) return;
    setFiles([...files, ...Array.from(selected).map((f) => f.name)]);
  }

  return (
    <HubShell variant="texture" width="6xl">
      <Link
        href={draftId ? `/intellengine/${draftId}` : "/intellengine"}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        IntellEngine
      </Link>

      <IntellEngineProgress percent={15} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-4xl space-y-6">
        {seed.origin !== "scratch" && (
          <div className="rounded-xl border border-brand-navy/10 bg-brand-cream/60 px-4 py-3 text-[13px] text-brand-navy/80">
            {seed.origin === "concept"
              ? "Prepopulated from the concept proposal your GRANTED team scoped for this grant — edit anything below."
              : "Starting from this grant's details — add your scope of work below."}
          </div>
        )}
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Project scope of work</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The high-level direction IntellEngine will draft the full proposal from. Adjust freely — you
            can refine individual sections later.
          </p>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={5}
            className="mt-4 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
          <p className={`mt-1.5 text-right text-[11px] ${overLimit ? "font-medium text-destructive" : "text-muted-foreground"}`}>
            {scopeWordCount} / {SCOPE_WORD_LIMIT} words
          </p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Your role</h2>
          <div className="mt-3 flex gap-3">
            {(["prime", "partner"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-full px-4 py-2 text-sm font-medium capitalize transition ${
                  role === r
                    ? "bg-brand-navy text-white"
                    : "border border-brand-navy/15 text-muted-foreground hover:border-brand-navy/30 hover:text-brand-navy"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Estimated budget</h2>
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="mt-3 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Partners</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Named or unnamed — each with the role they&apos;ll play and a short description of what they do.
          </p>

          {partners.length > 0 && (
            <div className="mt-4 space-y-3">
              {partners.map((p, i) =>
                editingIndex === i ? (
                  <div key={i} className="space-y-2 rounded-xl border border-brand-navy/20 bg-white p-4">
                    <input
                      value={editDraft.name}
                      onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                      placeholder="Organization name (optional)"
                      className="w-full rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
                    />
                    <input
                      value={editDraft.role}
                      onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value })}
                      placeholder="Role, e.g. Clinical services partner"
                      className="w-full rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
                    />
                    <input
                      value={editDraft.description}
                      onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                      placeholder="1-2 sentences on what they'll do"
                      className="w-full rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
                    />
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={saveEdit}
                        className="flex items-center gap-1 rounded-full bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-navyDeep"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setEditingIndex(null);
                          setEditNote(null);
                        }}
                        className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-brand-navy"
                      >
                        Cancel
                      </button>
                    </div>
                    {editNote && <p className="text-[12px] text-muted-foreground">{editNote}</p>}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="flex items-start justify-between gap-3 rounded-xl border border-brand-navy/10 bg-brand-cream/50 p-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-brand-navy">{p.name || "Unnamed partner"}</p>
                      <p className="text-xs font-medium text-brand-orange">{p.role}</p>
                      <p className="mt-1 text-[13px] text-muted-foreground">{p.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        onClick={() => startEdit(i)}
                        aria-label={`Edit ${p.name || "unnamed partner"}`}
                        className="text-muted-foreground hover:text-brand-navy"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removePartner(i)}
                        aria-label={`Remove ${p.name || "unnamed partner"}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}

          <div className="mt-4 grid gap-2 rounded-xl border border-dashed border-brand-navy/15 p-4 sm:grid-cols-2">
            <input
              value={draftPartner.name}
              onChange={(e) => setDraftPartner({ ...draftPartner, name: e.target.value })}
              placeholder="Organization name (optional)"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10 sm:col-span-2"
            />
            <input
              value={draftPartner.role}
              onChange={(e) => setDraftPartner({ ...draftPartner, role: e.target.value })}
              placeholder="Role, e.g. Clinical services partner"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
            <input
              value={draftPartner.description}
              onChange={(e) => setDraftPartner({ ...draftPartner, description: e.target.value })}
              placeholder="1-2 sentences on what they'll do"
              className="rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
            />
            <button
              onClick={addPartner}
              className="flex w-fit items-center gap-1 rounded-lg border border-brand-navy/15 px-3 py-2 text-sm font-medium text-brand-navy hover:border-brand-navy/30 sm:col-span-2"
            >
              <Plus className="h-4 w-4" />
              Add partner
            </button>
            {partnerNote && <p className="text-[12px] text-muted-foreground sm:col-span-2">{partnerNote}</p>}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Additional notes</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Anything else IntellEngine should factor in — context, constraints, prior conversations with
            your GRANTED team, whatever doesn&apos;t fit above.
          </p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Optional"
            className="mt-4 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Supporting files</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Budgets, prior proposals, letters of support — anything IntellEngine should draw from.
          </p>

          {files.length > 0 && (
            <div className="mt-4 space-y-2">
              {files.map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-brand-navy/10 bg-brand-cream/50 px-4 py-2.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm text-brand-navy">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{name}</span>
                  </span>
                  <button
                    onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                    aria-label={`Remove ${name}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => fileRef.current?.click()}
            className="mt-4 flex items-center gap-1.5 rounded-lg border border-dashed border-brand-navy/25 px-4 py-2.5 text-sm font-medium text-brand-navy hover:border-brand-navy/40"
          >
            <Upload className="h-4 w-4" />
            Upload files
          </button>
          {/* Not wired to real storage yet -- only the filename is kept, matching
              the shell scope of this pass (same pattern as the compliance page). */}
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // allow re-selecting the same filename after removing it
            }}
          />
        </div>

        <div className="flex justify-end">
          <ContinueButton
            draftId={draftId}
            nextHref="/intellengine/compliance"
            nextStatus="compliance"
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            Continue to compliance check
          </ContinueButton>
        </div>
      </div>
    </HubShell>
  );
}
