"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Paperclip, AlertTriangle, CheckCircle2 } from "lucide-react";

// Step 6 download surface: the "Submission package" panel on the build step's complete area. It
// fetches the completeness manifest + per-attachment signed URLs from ?format=links (no render), and
// links the narrative PDF / Word downloads at ?format=pdf|docx (rendered on click). The narrative is
// one document; attachments stay separate files -- the shape a human files into Grants.gov's per-slot
// uploads. Gaps are shown, never hidden: the person filing this needs to see what is not ready.

interface Attachment {
  id: string;
  title: string;
  contentType: string | null;
  sizeBytes: number | null;
  scope: "draft" | "org";
  url: string | null;
}

interface Manifest {
  rows: { label: string; present: boolean }[];
  missing: string[];
  empty: boolean;
}

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// reloadKey: the build page bumps it after every successful save, so the manifest + signed URLs
// REFETCH as the staffer fills in sections above this panel -- otherwise the download buttons and the
// "before you file" gaps stay frozen on the mount-time snapshot until a full reload. Same reloadKey
// pattern GrantBotWorkspace's ArtifactPanel uses (onTurnComplete). Refetches also re-mint the
// short-lived attachment signed URLs.
export function SubmissionPackagePanel({ draftId, reloadKey = 0 }: { draftId: string; reloadKey?: number }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Only the FIRST load shows the "loading" placeholder; a save-triggered refetch swaps data in place
  // rather than blanking the panel on every keystroke's autosave.
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setState("loading");
    try {
      const res = await fetch(`/api/intellengine/drafts/${draftId}/export?format=links`);
      if (!res.ok) {
        if (!loadedOnce.current) setState("error");
        return;
      }
      const data = (await res.json()) as { manifest: Manifest; attachments: Attachment[] };
      setManifest(data.manifest);
      setAttachments(data.attachments ?? []);
      setState("ready");
      loadedOnce.current = true;
    } catch {
      if (!loadedOnce.current) setState("error");
    }
  }, [draftId, reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const narrativeHref = (format: "pdf" | "docx") =>
    `/api/intellengine/drafts/${draftId}/export?format=${format}`;
  const canDownload = !!manifest && !manifest.empty;

  return (
    <div className="rounded-2xl bg-white p-6 shadow-grounded">
      <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Submission package</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Assemble the narrative and attachments to file with Grants.gov. Reflects your saved draft.
      </p>

      {state === "loading" && <p className="mt-4 text-[13px] text-muted-foreground">Checking the package…</p>}
      {state === "error" && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load the package.{" "}
          <button onClick={() => void load()} className="font-medium text-brand-orange hover:underline">
            Try again
          </button>
        </p>
      )}

      {state === "ready" && manifest && (
        <>
          {/* Gap summary — the honesty surface. */}
          {manifest.missing.length === 0 ? (
            <p className="mt-4 flex items-center gap-2 text-[13px] font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Everything is ready to file.
            </p>
          ) : (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4" /> Before you file
              </p>
              <ul className="mt-1 list-disc pl-5 text-[12.5px] text-amber-800">
                {manifest.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Narrative document downloads. */}
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Narrative document</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                href={canDownload ? narrativeHref("pdf") : undefined}
                aria-disabled={!canDownload}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition ${
                  canDownload ? "bg-brand-navy hover:bg-brand-navyDeep" : "pointer-events-none bg-brand-navy/40"
                }`}
              >
                <FileText className="h-3.5 w-3.5" /> Download PDF
              </a>
              <a
                href={canDownload ? narrativeHref("docx") : undefined}
                aria-disabled={!canDownload}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition ${
                  canDownload
                    ? "border border-brand-navy/20 bg-white text-brand-navy hover:bg-brand-navy/[0.04]"
                    : "pointer-events-none border border-brand-navy/10 bg-white text-brand-navy/40"
                }`}
              >
                <FileText className="h-3.5 w-3.5" /> Download Word
              </a>
            </div>
            {!canDownload && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Add a scope of work or draft a section to generate the narrative.
              </p>
            )}
          </div>

          {/* Attachments — separate files, one download link each. */}
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Attachments ({attachments.length})
            </p>
            {attachments.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-muted-foreground">No attachments uploaded for this pursuit.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {attachments.map((a) => {
                  const meta = [a.contentType ?? "", formatBytes(a.sizeBytes)].filter(Boolean).join(", ");
                  return (
                    <li key={a.id} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2 text-brand-navy">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {a.title}
                          {a.scope === "org" && <span className="text-muted-foreground"> · firm record</span>}
                          {meta && <span className="text-muted-foreground"> · {meta}</span>}
                        </span>
                      </span>
                      {a.url ? (
                        <a
                          href={a.url}
                          className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-orange hover:underline"
                        >
                          <Download className="h-3.5 w-3.5" /> Download
                        </a>
                      ) : (
                        <span className="shrink-0 text-muted-foreground">unavailable</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
