"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Pencil, Plus, X } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import { SaveIndicator } from "@/components/intellengine/save-indicator";
import { useDraftSave } from "@/components/intellengine/use-draft-save";
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
// IT SAVES NOW (step 2). Every field autosaves to intellengine_drafts.content.scope on a
// debounce, the indicator says which of saving / saved / not-saved is true, and Continue
// refuses to navigate if the flush fails -- see use-draft-save.ts for why each of those is
// load-bearing rather than polish.
//
// THE UPLOAD CONTROL IS GONE, deliberately, and comes back in step 3 with a bucket behind
// it. It kept the filename and discarded the file. That was uniformly broken on a page where
// nothing saved; on a page where everything else now persists it would be the one control
// that silently drops what it is handed, which is worse -- the surrounding page has earned
// the trust that makes the lie land.
export default function IntellEngineScopeClient({
  draftId,
  seed,
  backHref,
}: {
  draftId?: string;
  seed: ScopeSeed;
  // Where the top-left back link points. Staff (driven from the console hub) pass
  // their hub URL, since the default per-draft landing is client-only and would
  // bounce them to /clients. Clients omit it and get the normal landing.
  backHref?: string;
}) {
  const [scope, setScope] = useState(seed.scope);
  const [role, setRole] = useState<"prime" | "partner">(seed.role);
  const [budget, setBudget] = useState(seed.budget);
  const [partners, setPartners] = useState<Partner[]>(seed.partners);
  const [draftPartner, setDraftPartner] = useState({ name: "", role: "", description: "" });
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Partner>({ name: "", role: "", description: "" });
  const [notes, setNotes] = useState(seed.notes);
  const [partnerNote, setPartnerNote] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);

  // The exact object the save sends. Memoised so the debounce effect in useDraftSave sees a
  // new value only when a field actually changed, rather than on every render.
  const payload = useMemo(
    () => ({ scope, role, budget, partners, notes }),
    [scope, role, budget, partners, notes],
  );
  const saver = useDraftSave(draftId, "scope", payload);
  const { touch } = saver;

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
    touch();
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
    touch();
  }

  // Cancels any open edit before mutating the list -- editingIndex is a plain
  // array index, so removing a partner above the one being edited would leave
  // it pointing at the wrong row (or silently vanish/reappear on the wrong
  // partner as the list changes size).
  function removePartner(i: number) {
    setPartners(partners.filter((_, idx) => idx !== i));
    setEditingIndex(null);
    touch();
  }

  return (
    <HubShell variant="texture" width="6xl">
      <Link
        href={backHref ?? (draftId ? `/intellengine/${draftId}` : "/intellengine")}
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
        {/* "saved" renders NOTHING: once the client has written this themselves, a banner
            about where the prefill came from is both wrong and noise. */}
        {seed.origin !== "scratch" && seed.origin !== "saved" && (
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
            onChange={(e) => {
              setScope(e.target.value);
              touch();
            }}
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
                onClick={() => {
                  setRole(r);
                  touch();
                }}
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
            onChange={(e) => {
              setBudget(e.target.value);
              touch();
            }}
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
            onChange={(e) => {
              setNotes(e.target.value);
              touch();
            }}
            rows={4}
            placeholder="Optional"
            className="mt-4 w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        {/* NO UPLOAD CONTROL, on purpose. The old one kept the filename and threw the file
            away. On a page where nothing saved that was uniformly broken; on this page, where
            every other field now persists, it would be the single control that silently drops
            what it is given -- and the trust the rest of the page has earned is exactly what
            would make a client believe their audit had been received. It returns in step 3
            with a bucket behind it (docs/pursuit-state-audit-2026-08.md §5). */}
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Supporting files</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Budgets, prior proposals, letters of support. File upload isn&apos;t switched on yet —
            send anything you want IntellEngine to draw from to your GRANTED contact, and mention
            it in the notes above.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-4">
          <SaveIndicator saver={saver} />
          {/* beforeNavigate is the anti-silent-drop contract: Continue persists first and
              stays put if that fails, rather than carrying the client to the next step with
              their scope unsaved behind them.
              force: Continue ENDORSES the prefill. This editor opens filled from the released
              concept proposal, so a client who reads it, agrees, and continues has settled
              their scope even without typing -- and that should be recorded as theirs rather
              than leaving the draft reading "Not started". Mount still saves nothing; it is
              the deliberate click that carries the meaning. */}
          <ContinueButton
            draftId={draftId}
            nextHref="/intellengine/compliance"
            nextStatus="compliance"
            beforeNavigate={() => saver.flush({ force: true })}
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            Continue to compliance check
          </ContinueButton>
        </div>
      </div>
    </HubShell>
  );
}
