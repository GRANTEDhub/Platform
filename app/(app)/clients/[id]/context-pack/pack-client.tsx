"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Counts {
  documents: number;
  matches: number;
  detailedMatches: number;
  concepts: number;
  drafts: number;
  changes: number;
  gaps: number;
  words: number;
}

// Copy, download, and see-before-you-paste.
//
// THE PREVIEW IS NOT DECORATION. This brick exists to answer which context actually helps, and
// that question is unanswerable if the only way to read the pack is to paste it somewhere else
// first. It renders as pre-formatted text rather than rendered markdown on purpose: what gets
// pasted is the source, so the source is what should be on screen.
export default function PackClient({
  markdown,
  clientName,
  generatedAt,
  counts,
  dropped,
}: {
  markdown: string;
  clientName: string;
  generatedAt: string;
  counts: Counts;
  dropped: string[];
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused (permissions, an insecure context, an unusual
      // browser). Saying so beats a button that silently did nothing -- and the text is
      // already on screen below, selectable, which is the fallback.
      setCopyError(true);
    }
  }

  function download() {
    const slug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const stamp = generatedAt.slice(0, 10);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `context-pack-${slug || "client"}-${stamp}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-6 shadow-grounded">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[13px] text-muted-foreground">
            <p className="font-semibold text-brand-navy">
              {counts.words.toLocaleString()} words · {counts.documents} document
              {counts.documents === 1 ? "" : "s"} · {counts.matches} match
              {counts.matches === 1 ? "" : "es"} ({counts.detailedMatches} in full) ·{" "}
              {counts.concepts} concept{counts.concepts === 1 ? "" : "s"} · {counts.drafts} draft
              {counts.drafts === 1 ? "" : "s"} · {counts.changes} committed change
              {counts.changes === 1 ? "" : "s"}
            </p>
            <p className="mt-1">
              {counts.gaps} item{counts.gaps === 1 ? "" : "s"} in the “what the platform does not
              know” list at the end.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={download}>
              <span className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5" /> Download .md
              </span>
            </Button>
            <Button onClick={copy}>
              <span className="flex items-center gap-1.5">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy markdown"}
              </span>
            </Button>
          </div>
        </div>

        {copyError && (
          <p className="mt-3 text-[13px] font-medium text-destructive">
            Your browser refused clipboard access. Use Download, or select the text below.
          </p>
        )}

        {/* A CAP THAT BIT IS REPORTED, never silent: a pack that quietly stopped short reads as
            "this is everything", which is the one thing it must not imply. */}
        {dropped.length > 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-semibold">This pack is trimmed. What was left out:</p>
              <ul className="mt-1 list-disc pl-4">
                {dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <pre className="max-h-[70vh] overflow-auto rounded-2xl border border-brand-navy/[0.08] bg-white p-6 text-[12.5px] leading-relaxed text-brand-navy/90 shadow-grounded whitespace-pre-wrap">
        {markdown}
      </pre>
    </div>
  );
}
