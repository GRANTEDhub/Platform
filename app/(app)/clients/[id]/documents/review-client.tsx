"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, FileText, Loader2, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FieldProposal } from "@/lib/documents/proposal";
import type { ClientProfileChange } from "@/types/database";

interface DocSummary {
  id: string;
  title: string;
  kind: string;
  createdAt: string;
  isOrgLevel: boolean;
  status: string;
  extractedAt: string | null;
  error: string | null;
  reviewNote: string | null;
  docType: string | null;
  docDate: string | null;
  synopsis: string | null;
}

// Why a per-field rule refused a value, in words a reviewer can act on. A map rather than a
// ternary because there are three reasons now (0079's priority-area check added the third),
// and a two-branch expression silently reported every new reason as "can't be cleared".
const REJECTION_REASONS: Record<string, string> = {
  would_clear_protected_field: "can't be cleared",
  org_type_not_recognised: "unrecognised organization type",
  priority_area_not_recognised: "unrecognised priority area",
};

// The review screen. Renders proposals computed server-side by buildProposals, so it cannot
// offer a field the commit route would refuse.
//
// EVERY FIELD IS A DELIBERATE CLICK. Nothing arrives ticked, in either direction: the
// asymmetric default (iii) shipped -- fills pre-checked, overwrites not -- was argued against a
// stub extractor that proposed nothing, and the wrong extraction we actually expect (a 990's
// paid-preparer contact block read as the client's own) arrives as a FILL into a blank field.
// Pre-checking was backwards for the likeliest failure. Fill vs. overwrite is still LABELLED,
// and an overwrite still shows both values, because that is what a reviewer needs to judge it.
export default function AssimilationReview({
  reviews,
  history,
  // ORG-LEVEL FILING AND ORG-LEVEL DELETION ARE BOTH ADMIN-ONLY (0077, and canWriteDocument /
  // canDeleteDocument in lib/documents/authorize.ts), so one flag drives both.
  //
  // Was `canUpload`, renamed when delete arrived: two controls now read it, and a name that
  // describes one of them would have made the second look like a coincidence. The empty state
  // still needs it for its own reason -- the copy used to read "Upload one and it'll appear
  // here" on a screen with no upload control at all, and it must not be shown to a contractor
  // who has no way to act on it.
  isAdmin,
}: {
  reviews: { doc: DocSummary; proposals: FieldProposal[] }[];
  history: ClientProfileChange[];
  isAdmin: boolean;
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        {reviews.length === 0 && (
          <p className="rounded-2xl border border-dashed border-brand-navy/15 p-8 text-center text-sm text-muted-foreground">
            {isAdmin
              ? "No documents yet. Upload one above and it'll appear here for extraction."
              : "No documents on file yet."}
          </p>
        )}
        {reviews.map((r) => (
          <DocumentCard key={r.doc.id} doc={r.doc} proposals={r.proposals} isAdmin={isAdmin} />
        ))}
      </section>

      <ChangeHistory history={history} />
    </div>
  );
}

function defaultAcceptedMap(proposals: FieldProposal[]): Record<string, boolean> {
  return Object.fromEntries(proposals.map((p) => [p.field, p.defaultAccepted]));
}

function DocumentCard({
  doc,
  proposals,
  isAdmin,
}: {
  doc: DocSummary;
  proposals: FieldProposal[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  // Accepted state starts from defaultAccepted, which is now false for every proposal. Still
  // seeded from the server's value rather than from `{}` so the policy has exactly one home
  // (lib/documents/proposal.ts) and turning it back on stays a one-line change there.
  const [accepted, setAccepted] = useState<Record<string, boolean>>(() => defaultAcceptedMap(proposals));

  // RE-SEED WHEN THE PROPOSAL SET CHANGES, or the asymmetric default silently does not apply.
  //
  // Review finding on #340 (vercel[bot]), and it defeated the centrepiece of this design on
  // the most ordinary path. Extract and commit both call router.refresh(), which re-renders
  // the server component and hands down a NEW proposals array while REUSING this component
  // instance -- its key (doc.id) is stable. A useState initializer runs only on first mount,
  // so a document that mounted `pending` with zero proposals kept `accepted` = {} after
  // extraction, and every proposal rendered UNCHECKED -- including the fills that are meant
  // to arrive ticked. It would only have looked right after a full page reload, which is
  // exactly the path a preview check is least likely to take.
  //
  // Re-seeding DISCARDS in-progress ticks when the set changes, and that is correct rather
  // than unfortunate: if the proposals changed, the previous ticks referred to a set that no
  // longer exists, and carrying them forward would apply a decision to a different question.
  // THE KEY INCLUDES THE VALUES, not just the field names and directions. Second review
  // finding on #340, and it was the same bug one level down: keyed on field + direction alone,
  // a re-extraction returning a DIFFERENT value for the same field with the same fill/overwrite
  // classification produced an identical key, so the re-seed never fired and a previously
  // ticked overwrite stayed ticked -- committing a value the reviewer never saw when they
  // clicked. That is precisely the deliberate-click property this screen exists to provide,
  // defeated in the case it matters most: a non-deterministic extractor, which is what (iv)
  // installs. My own comment below already said the rule was "the previous ticks referred to a
  // set that no longer exists"; a changed value IS that, and the key did not implement it.
  //
  // (iv) NOTE: `defaultAccepted` is now constant false, so the VALUE components below are the
  // only thing left that can catch a re-extraction returning something different for the same
  // field. Keeping them is what makes the re-seed still fire -- and the case it guards is now
  // the ordinary one, since a real extractor is non-deterministic where the stub returned
  // nothing at all. Do not "simplify" this key back down to field names.
  const proposalsKey = proposals
    .map((p) => `${p.field}:${p.defaultAccepted}:${JSON.stringify(p.proposedValue)}:${JSON.stringify(p.currentValue)}`)
    .join("|");
  const [seededKey, setSeededKey] = useState(proposalsKey);
  if (proposalsKey !== seededKey) {
    setSeededKey(proposalsKey);
    setAccepted(defaultAcceptedMap(proposals));
  }
  const [note, setNote] = useState(doc.reviewNote ?? "");
  const [busy, setBusy] = useState<null | "extract" | "commit" | "delete">(null);
  // Deleting takes two clicks. Not a modal and not a window.confirm: the second click is in the
  // same place as the first, and the sentence that appears between them says what is actually
  // lost -- which a browser dialog cannot. Removing a file is the one irreversible action on
  // this screen (extraction overwrites itself, commits are undoable, rollbacks append).
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const chosen = proposals.filter((p) => accepted[p.field]);

  async function extract() {
    setBusy("extract");
    setMsg(null);
    try {
      const res = await fetch(`/api/client-documents/${doc.id}/extract`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Extraction failed.");
      // The server is the source of truth for what was extracted, so re-render from it
      // rather than patching local state into agreement with a guess.
      router.refresh();
      // THREE OUTCOMES, THREE SENTENCES. "Extracted." for both ready cases would tell a
      // reviewer that fields are waiting when the document produced none, and the failure case
      // carries the server's own message (a scan reads differently from a spreadsheet).
      setMsg({
        ok: body.status === "ready",
        text:
          body.status === "ready"
            ? body.foundNothing
              ? "Read it — nothing in it proposes a profile change."
              : "Extracted. Nothing is ticked; accept field by field."
            : body.error || "Couldn't read this document.",
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Extraction failed." });
    } finally {
      setBusy(null);
    }
  }

  // Remove the document and its stored file. The route (3b) deletes the row first and the
  // object best-effort after, and it re-checks authority server-side -- the gate below only
  // decides whether to OFFER the control.
  //
  // THE AUDIT TRAIL SURVIVES THIS, by construction rather than by care: 0078 declares
  // client_profile_changes.document_id as ON DELETE SET NULL, so committed changes stay in
  // Change history with their before/after intact and only lose the pointer to their cause.
  // Deleting a document cannot rewrite what it already changed.
  async function remove() {
    setBusy("delete");
    setMsg(null);
    try {
      const res = await fetch(`/api/client-documents/${doc.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Couldn't remove that file.");
      // No success banner: the card this message would render in is about to disappear, and a
      // refresh is the only confirmation that means anything here.
      router.refresh();
    } catch (e) {
      setConfirmingDelete(false);
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't remove that file." });
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    setBusy("commit");
    setMsg(null);
    try {
      const res = await fetch(`/api/client-documents/${doc.id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accepted: chosen.map((p) => ({ field: p.field, value: p.proposedValue })),
          note: note.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Couldn't save those changes.");
      router.refresh();
      // Reports what actually changed. `changed` can be shorter than what was ticked when a
      // value already matched -- saying "3 saved" for 1 write would be the small lie this
      // whole track exists to remove.
      const n = (body.changed ?? []).length;
      const refused = (body.rejected ?? []) as { field: string; reason: string }[];
      const base =
        n === 0 ? "Nothing to change — the profile already matched." : `${n} field${n === 1 ? "" : "s"} saved to the profile.`;
      // Refusals are NAMED. A per-field rule declining a value while the banner says "saved"
      // would be a success message doing less than it claims.
      const refusedNote = refused.length
        ? ` ${refused.length} not saved: ${refused
            .map((r) => `${r.field} (${REJECTION_REASONS[r.reason] ?? "refused by a field rule"})`)
            .join(", ")}.`
        : "";
      setMsg({ ok: refused.length === 0, text: base + refusedNote });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't save those changes." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-6 shadow-grounded">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brand-navy">{doc.title}</p>
            <p className="text-xs text-muted-foreground">
              {doc.isOrgLevel ? "Organization document" : "Pursuit attachment"} · {doc.kind}
              {doc.docType ? ` · reads as ${doc.docType}` : ""}
            </p>
            {/* A CLAIM, LABELLED. An extracted date is what the document appears to say, not a
                verified fact, and it is never written anywhere by this screen. */}
            {doc.docDate && (
              <p className="mt-1 text-xs text-muted-foreground">
                Document date: {doc.docDate}{" "}
                <span className="text-brand-navy/45">(extracted, not confirmed)</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={extract} disabled={busy !== null}>
            {busy === "extract" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…
              </span>
            ) : doc.status === "pending" ? (
              "Extract"
            ) : (
              "Re-extract"
            )}
          </Button>
          {/* ORG-LEVEL DELETE IS ADMIN-ONLY, so a contractor is shown no control rather than one
              that 403s on click -- the same rule the upload panel follows. A pursuit attachment
              (draft-level) is any staffer's to remove, which is canDeleteDocument's split
              mirrored here so the screen and the route agree. */}
          {(isAdmin || !doc.isOrgLevel) &&
            (confirmingDelete ? (
              <>
                <Button
                  variant="outline"
                  onClick={remove}
                  disabled={busy !== null}
                  className="border-destructive/40 text-destructive hover:bg-destructive/5"
                >
                  {busy === "delete" ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Removing…
                    </span>
                  ) : (
                    "Confirm remove"
                  )}
                </Button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy !== null}
                  className="text-xs text-muted-foreground underline underline-offset-2"
                >
                  Cancel
                </button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy !== null}
                aria-label={`Remove ${doc.title}`}
                title="Remove this document"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ))}
        </div>
      </div>

      {/* WHAT THE SECOND CLICK ACTUALLY DOES, said before it is available rather than after.
          Both halves matter: the file and its extraction are gone for good (there is no undo on
          this one), and anything already committed to the profile is NOT touched -- it stays in
          Change history, and rolling it back keeps working. */}
      {confirmingDelete && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>
            Removes the file and its extraction permanently — there&rsquo;s no undo. Profile
            changes already committed from it stay in Change history and can still be rolled back.
          </span>
        </p>
      )}

      {doc.synopsis && <p className="mt-4 text-[13px] text-brand-navy/80">{doc.synopsis}</p>}

      {doc.status === "failed" && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          {doc.error || "We couldn't read this document."}
        </p>
      )}

      {/* READ IT, FOUND NOTHING TO PROPOSE. Distinct from the amber failure block above, and the
          distinction is load-bearing: a scan that yielded no text is a FAILURE with its own
          message, never this sentence. Saying "we read this" about a document we could not read
          is the exact lie the text floor in extract-shape.ts exists to prevent. */}
      {doc.status === "ready" && proposals.length === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          We read this document — nothing in it proposes a change to the profile.
        </p>
      )}

      {proposals.length > 0 && (
        <div className="mt-5 space-y-3">
          {proposals.map((p) => (
            <label
              key={p.field}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 ${
                p.isFill ? "border-brand-navy/10 bg-white" : "border-amber-200 bg-amber-50/40"
              }`}
            >
              <input
                type="checkbox"
                checked={!!accepted[p.field]}
                onChange={(e) => setAccepted({ ...accepted, [p.field]: e.target.checked })}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-brand-navy">
                  {p.label}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {p.isFill ? "· filling a blank" : "· replacing what's there"}
                  </span>
                </p>
                {/* SIDE BY SIDE for an overwrite. A replacement the reviewer cannot see is a
                    replacement they cannot judge. */}
                {!p.isFill && (
                  <p className="mt-1.5 text-[13px] text-brand-navy/55 line-through">
                    {renderValue(p.currentValue)}
                  </p>
                )}
                <p className="mt-1 text-[13px] text-brand-navy/85">{renderValue(p.proposedValue)}</p>
                {/* WHERE IT CAME FROM, VERBATIM. The failure this catches: a contact block read
                    correctly off a 990's "Paid Preparer Use Only" section, or an audit firm's
                    letterhead — a valid name and a valid email belonging to the wrong
                    organization, which no validation can detect. Quoted here, whose details
                    they are is visible without opening the document. */}
                {p.evidence && (
                  <p className="mt-2 border-l-2 border-brand-navy/15 pl-2.5 text-xs italic text-brand-navy/55">
                    “{p.evidence}”
                  </p>
                )}
              </div>
            </label>
          ))}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Note for the record (optional) — why you accepted or rejected these"
            className="w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy/35"
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={commit} disabled={busy !== null || chosen.length === 0}>
              {busy === "commit" ? "Saving…" : `Save ${chosen.length} to profile`}
            </Button>
            {/* NOTHING ARRIVES TICKED, in either direction, so the hint is unconditional now.
                It used to fire only when an overwrite was present, which was correct while
                fills arrived pre-checked and would now describe the screen wrongly. */}
            <span className="text-xs text-muted-foreground">
              Nothing is ticked — accept each field deliberately.
            </span>
          </div>
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-[13px] font-medium ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// The audit trail, and the undo. Rollback writes NEW rows rather than deleting these, so a
// reverted change stays visible as two entries -- which is the point.
function ChangeHistory({ history }: { history: ClientProfileChange[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Grouped by commit so a sitting reads as one action rather than N rows.
  const commits = new Map<string, ClientProfileChange[]>();
  for (const h of history) {
    const list = commits.get(h.commit_id);
    if (list) list.push(h);
    else commits.set(h.commit_id, [h]);
  }

  async function rollback(commitId: string) {
    setBusy(commitId);
    setError(null);
    try {
      const res = await fetch(`/api/client-profile-changes/${commitId}/rollback`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Couldn't undo that change.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo that change.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Change history</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Every committed change, who made it, and what it replaced. Undoing writes a new entry —
        nothing is erased.
      </p>

      {commits.size === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">No profile changes recorded yet.</p>
      )}

      <div className="mt-4 space-y-3">
        {[...commits.entries()].map(([commitId, rows]) => (
          <div key={commitId} className="rounded-xl border border-brand-navy/[0.08] bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-brand-navy">
                  {rows.length} field{rows.length === 1 ? "" : "s"} ·{" "}
                  {rows[0].committed_by_email || "unknown"}{" "}
                  <span className="font-normal text-muted-foreground">({rows[0].committed_by_kind})</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(rows[0].committed_at).toLocaleString()}
                </p>
                {rows[0].note && (
                  <p className="mt-1.5 text-[13px] text-brand-navy/75">&ldquo;{rows[0].note}&rdquo;</p>
                )}
              </div>
              <Button variant="outline" onClick={() => rollback(commitId)} disabled={busy !== null}>
                {busy === commitId ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Undoing…
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Undo2 className="h-3.5 w-3.5" /> Undo
                  </span>
                )}
              </Button>
            </div>
            <ul className="mt-3 space-y-1.5 border-t border-brand-navy/10 pt-3">
              {rows.map((r) => (
                <li key={r.id} className="text-[12.5px]">
                  <span className="font-medium text-brand-navy">{r.field}</span>{" "}
                  <span className="text-brand-navy/50 line-through">{renderValue(r.old_value)}</span>{" "}
                  <Check className="inline h-3 w-3 text-emerald-600" />{" "}
                  <span className="text-brand-navy/85">{renderValue(r.new_value)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-[13px] font-medium text-destructive">{error}</p>}
    </section>
  );
}

// Values are strings, string arrays, or arrays of objects (programs / partners). Rendered
// for a human without pretending a JSON blob is prose.
function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "string") return v.length > 240 ? `${v.slice(0, 240)}…` : v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "(empty)";
    if (v.every((x) => typeof x === "string")) return (v as string[]).join(" · ");
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  return JSON.stringify(v);
}
