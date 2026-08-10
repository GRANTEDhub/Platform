"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, FileText, Loader2, Undo2 } from "lucide-react";
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

// The review screen. Renders proposals computed server-side by buildProposals, so it cannot
// offer a field the commit route would refuse.
//
// THE ASYMMETRIC DEFAULT IS THE WHOLE INTERACTION. A proposal that FILLS an empty field
// arrives checked; one that would OVERWRITE arrives unchecked with both values shown. That
// makes the cheap direction one click and the expensive direction a decision -- and it is why
// this screen can be trusted with an extractor nobody has validated yet.
export default function AssimilationReview({
  reviews,
  history,
}: {
  reviews: { doc: DocSummary; proposals: FieldProposal[] }[];
  history: ClientProfileChange[];
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        {reviews.length === 0 && (
          <p className="rounded-2xl border border-dashed border-brand-navy/15 p-8 text-center text-sm text-muted-foreground">
            No documents yet. Upload one and it&apos;ll appear here for extraction.
          </p>
        )}
        {reviews.map((r) => (
          <DocumentCard key={r.doc.id} doc={r.doc} proposals={r.proposals} />
        ))}
      </section>

      <ChangeHistory history={history} />
    </div>
  );
}

function defaultAcceptedMap(proposals: FieldProposal[]): Record<string, boolean> {
  return Object.fromEntries(proposals.map((p) => [p.field, p.defaultAccepted]));
}

function DocumentCard({ doc, proposals }: { doc: DocSummary; proposals: FieldProposal[] }) {
  const router = useRouter();
  // Accepted state starts from defaultAccepted -- pre-checked fills, unchecked overwrites.
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
  const proposalsKey = proposals.map((p) => `${p.field}:${p.defaultAccepted}`).join("|");
  const [seededKey, setSeededKey] = useState(proposalsKey);
  if (proposalsKey !== seededKey) {
    setSeededKey(proposalsKey);
    setAccepted(defaultAcceptedMap(proposals));
  }
  const [note, setNote] = useState(doc.reviewNote ?? "");
  const [busy, setBusy] = useState<null | "extract" | "commit">(null);
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
      setMsg({
        ok: body.status === "ready",
        text: body.status === "ready" ? "Extracted." : body.error || "Couldn't read this document.",
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Extraction failed." });
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
      setMsg({
        ok: true,
        text: n === 0 ? "Nothing to change — the profile already matched." : `${n} field${n === 1 ? "" : "s"} saved to the profile.`,
      });
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
      </div>

      {doc.synopsis && <p className="mt-4 text-[13px] text-brand-navy/80">{doc.synopsis}</p>}

      {doc.status === "failed" && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          {doc.error || "We couldn't read this document."}
        </p>
      )}

      {doc.status === "ready" && proposals.length === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          Nothing to propose — the extraction found no profile details this document could add.
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
            <span className="text-xs text-muted-foreground">
              {proposals.filter((p) => !p.isFill).length > 0 &&
                "Replacements are unticked by default — tick only what you want overwritten."}
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
