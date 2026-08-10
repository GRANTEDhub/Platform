"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import {
  CLIENT_UPLOAD_KINDS,
  KIND_LABEL,
  UPLOAD_MAX_LABEL,
  type ClientUploadKind,
} from "@/lib/documents/kinds";
import { useDocumentUpload } from "@/components/documents/use-document-upload";

// The org-level upload front door for assimilation.
//
// WHY THIS EXISTS AT ALL: the review screen shipped saying "Upload one and it'll appear here"
// with no way to upload. That is the same copy-vs-reality defect this whole brick was built to
// remove, in the screen that removed it -- a page promising an action it does not offer. Staff
// had to insert rows by SQL to test anything.
//
// ORG-LEVEL, so three things differ from the client-facing 3c control:
//   * scope is `clientId`, not a draft -- these are firm records, not one pursuit's attachments
//   * ADMIN ONLY. 0077 kept org-level writes at is_admin(), so a contractor gets the list and
//     an explanation, never a button that 403s. A button that fails on click is the same lie as
//     copy describing a control that is not there.
//   * client_visible stays FALSE. The confirm route defaults it that way for org-level (step
//     (ii)), which is exactly the retained-not-surfaced case: the raw file is kept so extraction
//     can be re-run against it, never so a client can browse it.
//
// The three-call sequence itself is useDocumentUpload, shared with 3c rather than copied.
export default function UploadPanel({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<ClientUploadKind>("org_docs");
  const [note, setNote] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { run, busy, error, setError } = useDocumentUpload();

  async function handleFile(file: File) {
    setNote(null);
    const result = await run(file, kind, { clientId });
    if (!result) return; // the hook set the error; nothing was recorded
    if (fileInput.current) fileInput.current.value = "";

    // AUTO-EXTRACT, as a SEPARATE request. Uploading and extracting stay two calls on purpose:
    // extraction is the slow, fallible half and becomes an LLM call in (iv), so a failure here
    // must leave a perfectly good document row that can be re-extracted -- not lose the upload.
    // Hence the message distinguishes "filed but not read" from "filed and read".
    setExtracting(true);
    try {
      const res = await fetch(`/api/client-documents/${result.document.id}/extract`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(`Uploaded. Extraction didn't run — use Extract on the document below. (${body?.error ?? "unknown error"})`);
      } else if (body.status === "failed") {
        setNote(`Uploaded. ${body.error ?? "We couldn't read this document."}`);
      } else {
        setNote("Uploaded and extracted.");
      }
    } catch (e) {
      setNote(`Uploaded. Extraction didn't run — use Extract on the document below. (${e instanceof Error ? e.message : "network error"})`);
    } finally {
      setExtracting(false);
      // The server is the source of truth for both the row and the extraction, so re-render
      // from it rather than assembling a local guess at what the card should say.
      router.refresh();
    }
  }

  // NOT a disabled button. A contractor is told who does this, because a control that exists
  // and refuses is worse than one that is honestly absent.
  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-dashed border-brand-navy/15 p-5 text-[13px] text-muted-foreground">
        Organization documents are filed by an admin. Anything already on file appears below.
      </div>
    );
  }

  const working = busy || extracting;

  return (
    <div className="rounded-2xl border border-dashed border-brand-navy/15 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Upload className="h-4 w-4 shrink-0 text-brand-navy/50" />
        <label className="text-[13px] text-muted-foreground">
          Type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ClientUploadKind)}
            disabled={working}
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
          disabled={working}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          className="text-[13px] text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-brand-navy file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-brand-navyDeep disabled:opacity-60"
        />

        {working && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {busy ? "Uploading…" : "Extracting…"}
          </span>
        )}
      </div>

      <p className="mt-2.5 text-[12px] text-muted-foreground">
        PDF or Word, up to {UPLOAD_MAX_LABEL}. Kept for re-extraction only — not shown to the
        client. Spreadsheets can be stored but not read.
      </p>

      {/* An upload failure shows here and NO document card appears -- the row only exists if
          confirm returned one. */}
      {error && (
        <p className="mt-3 text-[12px] font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
      {note && !error && <p className="mt-3 text-[12px] text-muted-foreground">{note}</p>}
    </div>
  );
}
