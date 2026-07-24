"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Pencil, Plus, X } from "lucide-react";
import type { ConceptProposal, ConceptProposalPartner, ConceptProposalRow } from "@/types/database";

// Right-side slide-over for editing the generated concept proposal (Tara's edit
// request). Staff-only; opens over the account-manager grant detail view. Saves
// the whole proposal via PUT /api/concept/[cardId], which stamps edited_by/at so
// a later Regenerate can warn before overwriting. Mirrors the field patterns of
// the IntellEngine /scope editor; kept separate because the shapes differ
// (source tags, match, term) -- unify once the client-side IntellEngine consumer
// is built.

const SCOPE_WORD_LIMIT = 500;

type PartnerDraft = { name: string; org_type_label: string; role: string; description: string };
const EMPTY_PARTNER: PartnerDraft = { name: "", org_type_label: "", role: "", description: "" };

function toDraft(p: ConceptProposalPartner): PartnerDraft {
  return { name: p.name ?? "", org_type_label: p.org_type_label ?? "", role: p.role, description: p.description };
}

// Manual edits are staff-vetted, so an AM-touched partner is tagged "manual"
// (never the unverified "suggested"). An untouched, still-machine-sourced row
// keeps its original provenance.
function fromDraft(d: PartnerDraft, prior?: ConceptProposalPartner): ConceptProposalPartner {
  const name = d.name.trim() || null;
  return {
    name,
    org_type_label: name ? null : d.org_type_label.trim() || null,
    role: d.role.trim(),
    description: d.description.trim(),
    source: prior && prior.source !== "suggested" ? prior.source : "manual",
  };
}

export function ConceptProposalEditor({
  cardId,
  initial,
  onClose,
  onSaved,
}: {
  cardId: string;
  initial: ConceptProposal;
  onClose: () => void;
  onSaved: (row: ConceptProposalRow) => void;
}) {
  const [scope, setScope] = useState(initial.scope);
  const [role, setRole] = useState<"prime" | "partner">(initial.role);
  const [total, setTotal] = useState(initial.total_project_amount);
  const [noMatch, setNoMatch] = useState(initial.estimated_match === null);
  const [match, setMatch] = useState(initial.estimated_match ?? "");
  const [term, setTerm] = useState(initial.project_term ?? "");
  const [partners, setPartners] = useState<ConceptProposalPartner[]>(initial.partners);
  const [draft, setDraft] = useState<PartnerDraft>(EMPTY_PARTNER);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<PartnerDraft>(EMPTY_PARTNER);
  const [partnerNote, setPartnerNote] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(true); // trigger the slide-in after mount
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // lock the background while the pane is open
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const wordCount = scope.trim() ? scope.trim().split(/\s+/).length : 0;
  const overLimit = wordCount > SCOPE_WORD_LIMIT;

  function addPartner() {
    if (!draft.role.trim() && !draft.description.trim()) {
      setPartnerNote("Add a role or description before adding this partner.");
      return;
    }
    setPartners([...partners, fromDraft(draft)]);
    setDraft(EMPTY_PARTNER);
    setPartnerNote(null);
  }

  function saveEdit() {
    if (editingIndex === null) return;
    if (!editDraft.role.trim() && !editDraft.description.trim()) {
      setPartnerNote("Add a role or description before saving.");
      return;
    }
    setPartners(partners.map((p, i) => (i === editingIndex ? fromDraft(editDraft, p) : p)));
    setEditingIndex(null);
    setPartnerNote(null);
  }

  function removePartner(i: number) {
    setPartners(partners.filter((_, idx) => idx !== i));
    setEditingIndex(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const payload: ConceptProposal = {
      scope: scope.trim(),
      role,
      total_project_amount: total.trim(),
      estimated_match: noMatch ? null : match.trim() || null,
      project_term: term.trim() || null,
      partners,
    };
    try {
      const res = await fetch(`/api/concept/${cardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { proposal?: ConceptProposalRow; error?: string };
      if (!res.ok || !body.proposal) {
        setError(body.error || "Couldn't save. Try again.");
        return;
      }
      onSaved(body.proposal);
      handleClose();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setTimeout(onClose, 200); // let the slide-out play
  }

  // Portal to <body> so the fixed overlay anchors to the viewport, not the
  // transformed HubShell ancestor (a fixed element inside a transformed ancestor
  // is positioned relative to THAT ancestor, which made the pane render as a tall
  // in-page column instead of a viewport drawer).
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-brand-navy/30 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={handleClose}
      />
      <div
        className={`absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-brand-navy/[0.08] px-6 py-4">
          <h2 className="font-serif text-lg font-semibold text-brand-navy">Edit concept proposal</h2>
          <button onClick={handleClose} aria-label="Close" className="text-muted-foreground hover:text-brand-navy">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <Field label="Project scope">
            <textarea
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              rows={7}
              className={inputCls}
            />
            <p className={`mt-1 text-right text-[11px] ${overLimit ? "font-medium text-destructive" : "text-muted-foreground"}`}>
              {wordCount} / {SCOPE_WORD_LIMIT} words
            </p>
          </Field>

          <Field label="Suggested role">
            <div className="flex gap-2">
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
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total project amount (est.)">
              <input value={total} onChange={(e) => setTotal(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Estimated match">
              <input
                value={noMatch ? "" : match}
                onChange={(e) => setMatch(e.target.value)}
                disabled={noMatch}
                placeholder={noMatch ? "None required" : ""}
                className={`${inputCls} disabled:bg-brand-navy/[0.03] disabled:text-muted-foreground`}
              />
              <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <input type="checkbox" checked={noMatch} onChange={(e) => setNoMatch(e.target.checked)} />
                No match required
              </label>
            </Field>
          </div>

          <Field label="Project term">
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. 3 years (leave blank if the NOFO is silent)"
              className={inputCls}
            />
          </Field>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Partners</p>
            <div className="mt-3 space-y-3">
              {partners.map((p, i) =>
                editingIndex === i ? (
                  <div key={i} className="space-y-2 rounded-xl border border-brand-navy/20 p-3">
                    <PartnerInputs draft={editDraft} onChange={setEditDraft} />
                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={saveEdit} className="flex items-center gap-1 rounded-full bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-navyDeep">
                        <Check className="h-3.5 w-3.5" />
                        Save
                      </button>
                      <button onClick={() => { setEditingIndex(null); setPartnerNote(null); }} className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-brand-navy">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex items-start justify-between gap-3 rounded-xl border border-brand-navy/10 bg-brand-cream/40 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-brand-navy">{p.name || p.org_type_label || "Partner"}</p>
                      {p.role && <p className="text-xs font-medium text-brand-orange">{p.role}</p>}
                      {p.description && <p className="mt-1 text-[13px] text-muted-foreground">{p.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button onClick={() => { setEditingIndex(i); setEditDraft(toDraft(p)); setPartnerNote(null); }} aria-label="Edit partner" className="text-muted-foreground hover:text-brand-navy">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => removePartner(i)} aria-label="Remove partner" className="text-muted-foreground hover:text-destructive">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ),
              )}
            </div>

            <div className="mt-3 space-y-2 rounded-xl border border-dashed border-brand-navy/15 p-3">
              <PartnerInputs draft={draft} onChange={setDraft} />
              <button onClick={addPartner} className="flex w-fit items-center gap-1 rounded-lg border border-brand-navy/15 px-3 py-2 text-sm font-medium text-brand-navy hover:border-brand-navy/30">
                <Plus className="h-4 w-4" />
                Add partner
              </button>
            </div>
            {partnerNote && <p className="mt-1.5 text-[12px] text-muted-foreground">{partnerNote}</p>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-brand-navy/[0.08] px-6 py-4">
          {error && <span className="mr-auto text-[12.5px] text-destructive">{error}</span>}
          <button onClick={handleClose} className="rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:text-brand-navy">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-6 py-2 text-sm font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const inputCls =
  "w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function PartnerInputs({ draft, onChange }: { draft: PartnerDraft; onChange: (d: PartnerDraft) => void }) {
  const smallCls =
    "w-full rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10";
  return (
    <>
      <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="Organization name (optional)" className={smallCls} />
      <input value={draft.org_type_label} onChange={(e) => onChange({ ...draft, org_type_label: e.target.value })} placeholder="…or org type if unnamed, e.g. workforce partner" className={smallCls} />
      <input value={draft.role} onChange={(e) => onChange({ ...draft, role: e.target.value })} placeholder="Role, e.g. clinical services partner" className={smallCls} />
      <input value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} placeholder="1-2 sentences on what they'll do" className={smallCls} />
    </>
  );
}
