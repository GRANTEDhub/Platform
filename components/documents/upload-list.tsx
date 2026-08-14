"use client";

import { useRef, useState } from "react";
import { Download, Loader2, Paperclip, Trash2 } from "lucide-react";
import {
  CLIENT_UPLOAD_KINDS,
  KIND_LABEL,
  UPLOAD_MAX_LABEL,
  type ClientUploadKind,
} from "@/lib/documents/kinds";
import { useDocumentUpload } from "./use-document-upload";
import { formatBytes } from "@/lib/format/bytes";
import type { DocumentListItem } from "@/lib/documents/list";

// The real supporting-files control (Pursuit step 3c). Replaces the placeholder card that
// kept a filename and threw the file away.
//
// THREE CALLS, AND THE ORDER IS THE HONESTY GUARANTEE:
//   1. POST /api/client-documents/mint   -> authorises, returns a one-object signed URL,
//                                           writes NOTHING
//   2. PUT to that URL                   -> the bytes go browser -> storage, bypassing our
//                                           ~4.5MB serverless body limit entirely
//   3. POST /api/client-documents        -> reads back what storage actually holds and
//                                           inserts the row
//
// A FILE ROW APPEARS ONLY AFTER STEP 3 RETURNS ONE. Nothing optimistic, no placeholder row,
// no local entry that "will sync". If any step fails the client sees an error and no row --
// because a rendered file line is precisely the lie this brick exists to remove, and it is
// most convincing on a page where everything else is real.
export default function DocumentUploadList({
  draftId,
  initial,
  onBusyChange,
}: {
  // No draft, no uploads. A staff preview of the flow has no draft to attach a file to, and
  // the mint route would refuse anyway -- so the control renders read-only rather than
  // offering something that cannot work.
  draftId?: string;
  initial: DocumentListItem[];
  // Lets the page block Continue while bytes are in flight. Uploads deliberately do NOT go
  // through the draft autosave (different table, different route), so the autosave's flush
  // knows nothing about them -- without this, Continue could navigate mid-PUT and the file
  // would be lost with no error anywhere.
  onBusyChange?: (busy: boolean) => void;
}) {
  const [docs, setDocs] = useState<DocumentListItem[]>(initial);
  const [kind, setKind] = useState<ClientUploadKind>("other");
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The three-call sequence lives in useDocumentUpload, shared with the staff assimilation
  // screen. One implementation on purpose -- two copies of an authorisation dance drift.
  const { run, busy: uploading, error, setError } = useDocumentUpload();

  async function handleFile(file: File) {
    // onBusyChange is what lets the page block Continue mid-upload: uploads are a second
    // persistence path the draft autosave cannot see, so without it a client could navigate
    // away during the PUT and lose the file with nothing reporting it.
    // Guarded rather than cast. The control only renders its file input when draftId exists,
    // but `as string` would be a promise the type system stops checking -- and mint would
    // refuse a draft-less upload anyway, so a silent no-op here beats a confusing 400.
    if (!draftId) return;
    onBusyChange?.(true);
    const result = await run(file, kind, { draftId });
    onBusyChange?.(false);
    // A row only when the server returned one -- see useDocumentUpload. On failure the hook
    // has set the error and nothing is appended, so a failed upload never renders a file line.
    if (result) {
      setDocs((prev) => [...prev, result.document]);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Opens in a new tab via a freshly minted signed URL. The URL is never rendered into the
  // page or held on the row -- it is a bearer token for the bytes, so it is fetched at the
  // moment of the click and expires on its own.
  async function open(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/client-documents/${id}/url`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.url) throw new Error(body?.error || "Couldn't open that file.");
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that file.");
    } finally {
      setBusyId(null);
    }
  }

  // The row goes only after the server says it did. The route deletes the row first and the
  // object second, so a failure here leaves the file listed and openable rather than showing a
  // client a file that is gone.
  async function remove(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/client-documents/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Couldn't remove that file. Try again.");
      }
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove that file. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-grounded">
      <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Supporting files</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Budgets, prior proposals, letters of support — anything IntellEngine should draw from.
        Optional. PDF, Word or Excel, up to {UPLOAD_MAX_LABEL} each.
      </p>

      {docs.length > 0 && (
        <ul className="mt-4 space-y-2">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-brand-navy/10 bg-brand-cream/50 p-3"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <Paperclip className="h-4 w-4 shrink-0 text-brand-navy/50" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-navy">{d.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {KIND_LABEL[d.kind as ClientUploadKind] ?? d.kind}
                    {d.size_bytes ? ` · ${formatBytes(d.size_bytes)}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  onClick={() => open(d.id)}
                  disabled={busyId === d.id}
                  aria-label={`Open ${d.title}`}
                  className="text-muted-foreground transition-colors hover:text-brand-navy disabled:opacity-50"
                >
                  {busyId === d.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </button>
                <button
                  onClick={() => remove(d.id)}
                  disabled={busyId === d.id}
                  aria-label={`Remove ${d.title}`}
                  className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draftId ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-brand-navy/15 p-4">
          <label className="text-[13px] text-muted-foreground">
            Type
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ClientUploadKind)}
              disabled={uploading}
              className="ml-2 rounded-lg border border-brand-navy/15 bg-white px-2.5 py-1.5 text-sm text-brand-navy outline-none focus:border-brand-navy/35 disabled:opacity-60"
            >
              {CLIENT_UPLOAD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={fileInput}
            type="file"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
            className="text-[13px] text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-brand-navy file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-brand-navyDeep disabled:opacity-60"
          />

          {uploading && (
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading…
            </span>
          )}
        </div>
      ) : (
        // Staff previewing a step URL with no ?draft. Says why rather than showing a control
        // that would be refused by the route.
        <p className="mt-4 text-[12px] text-muted-foreground">
          Open a client&apos;s proposal to add files.
        </p>
      )}

      {/* The error is the whole point of the failure path: no row is added, so this line is
          the ONLY thing that tells the client their file did not arrive. */}
      {error && <p className="mt-3 text-[12px] font-medium text-destructive">{error}</p>}
    </div>
  );
}
