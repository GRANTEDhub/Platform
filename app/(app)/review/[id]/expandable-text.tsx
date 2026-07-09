"use client";

import { useState } from "react";

// Plain-text sibling of ExpandableDescription (same "Show more/less" UX and orange
// toggle), for the merged Match-summary box's full reasoning -- keeps the score
// justification from becoming a wall of text. Short text renders inline with no
// toggle; long text shows a word-safe preview + expander.
export function ExpandableText({
  text,
  previewChars = 180,
  className,
}: {
  text: string;
  previewChars?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const t = text.trim();
  if (t.length <= previewChars) return <p className={className}>{t}</p>;

  const cut = t.slice(0, previewChars);
  const sp = cut.lastIndexOf(" ");
  const preview = (sp > previewChars * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:–—-]+$/, "") + "…";

  return (
    <div className={className}>
      <p className="whitespace-pre-wrap">{open ? t : preview}</p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1.5 text-xs font-semibold text-brand-orange hover:underline"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
