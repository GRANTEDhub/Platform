"use client";

import { useState } from "react";

// "What it funds" description with a Show more/less expander for long grants, so
// a long description doesn't strand whitespace next to the shorter "Who can apply"
// column. Both `preview` and `full` are already-sanitized HTML; the server only
// mounts this when the description is actually long (preview truncated on a
// sentence boundary), otherwise it renders the plain block.
export function ExpandableDescription({
  preview,
  full,
  className,
}: {
  preview: string;
  full: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <div dangerouslySetInnerHTML={{ __html: open ? full : preview }} />
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
