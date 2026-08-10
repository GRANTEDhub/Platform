"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
  isAllowedUploadMime,
  type ClientUploadKind,
} from "@/lib/documents/kinds";
import type { DocumentListItem } from "@/lib/documents/list";

// THE ONE IMPLEMENTATION of mint -> PUT -> confirm.
//
// Extracted from components/documents/upload-list.tsx when the staff assimilation screen
// needed the same sequence for ORG-LEVEL uploads. Deliberately one copy rather than two:
// this is a three-call authorisation dance, and two copies of it drift into a security gap
// the day one gains a check the other does not. The 3c pursuit control now calls this too,
// so the client path and the staff path cannot diverge.
//
// THE ORDER IS THE HONESTY GUARANTEE, unchanged:
//   1. mint    -> authorises, returns a one-object signed URL, writes NOTHING
//   2. PUT     -> bytes go browser -> storage, bypassing the ~4.5MB serverless body limit
//   3. confirm -> reads back what storage actually holds, and only then inserts the row
//
// A ROW EXISTS ONLY AFTER STEP 3 RETURNS ONE. Nothing optimistic, ever: this hook resolves
// with the server's row or it throws, so no caller can render a file line for an upload that
// did not land. That was the original defect in the discarding upload control, and it must
// not come back through a convenience layer.

// Draft-level (a client's own pursuit file) or org-level (a firm record / assimilation
// source). Exactly one is set, which is what decides visibility server-side: the confirm
// route forces client_visible true for draft-level and leaves it false for org-level unless
// an admin explicitly shares it. See app/api/client-documents/route.ts.
export type UploadScope =
  | { draftId: string; clientId?: never }
  | { clientId: string; draftId?: never };

export interface UploadResult {
  document: DocumentListItem;
}

export function useDocumentUpload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Throws on any failure, with a message fit to show a human. Callers decide what to do with
  // the returned row -- append it to a list, or refresh the server component.
  async function upload(file: File, kind: ClientUploadKind, scope: UploadScope): Promise<UploadResult> {
    // Checked here as well as in the route and on the bucket, purely for speed of feedback:
    // this refusal is instant, where the same answer from storage arrives after the user has
    // watched a 20MB upload run. The bucket remains the real enforcement (0075).
    if (!isAllowedUploadMime(file.type)) {
      throw new Error("That file type isn't supported. Upload a PDF, Word or Excel document.");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new Error(`That file is over ${UPLOAD_MAX_LABEL}.`);
    }

    // ── 1. mint ──
    const mintRes = await fetch("/api/client-documents/mint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        ...scope,
      }),
    });
    const mint = await mintRes.json().catch(() => ({}));
    if (!mintRes.ok) throw new Error(mint?.error || "Couldn't start the upload. Try again.");

    // ── 2. the bytes ──
    // uploadToSignedUrl rather than a hand-rolled PUT: the token, the endpoint shape and the
    // multipart/raw body handling are the storage client's business, and getting any of them
    // subtly wrong would fail at exactly the moment someone is trusting us with a file.
    // contentType is passed explicitly so what storage records matches the real file --
    // confirm reads it back and rejects a mismatch, so a wrong value surfaces as a refused
    // upload rather than a mislabelled row.
    const supabase = createClient();
    const { error: putError } = await supabase.storage
      .from(mint.bucket)
      .uploadToSignedUrl(mint.path, mint.token, file, { contentType: file.type });
    if (putError) throw new Error("That file didn't finish uploading. Try again.");

    // ── 3. confirm ──
    // The ONLY step that produces a row.
    const confirmRes = await fetch("/api/client-documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: mint.path, kind, title: file.name, ...scope }),
    });
    const confirmed = await confirmRes.json().catch(() => ({}));
    if (!confirmRes.ok || !confirmed?.document) {
      throw new Error(confirmed?.error || "Couldn't record that file. Try again.");
    }
    return { document: confirmed.document as DocumentListItem };
  }

  // Wraps upload with the busy/error state both surfaces need, and resolves to the row or
  // null. Never throws, so a caller cannot forget to catch and leave the button spinning.
  async function run(
    file: File,
    kind: ClientUploadKind,
    scope: UploadScope,
  ): Promise<UploadResult | null> {
    setBusy(true);
    setError(null);
    try {
      return await upload(file, kind, scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't upload that file. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, error, setError };
}
