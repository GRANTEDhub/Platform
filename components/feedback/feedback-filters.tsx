"use client";

import { useRouter, useSearchParams } from "next/navigation";

// Filter controls for the staff Feedback repository (#23): verdict chips (all / agreed
// / flagged) + a client dropdown. Server-driven — each change pushes query params and
// the page re-reads them. Both purposes are one control: no client filter = the global
// calibration view; a client selected = that client's calibration view.
export function FeedbackFilters({
  clients,
  clientId,
  verdict,
}: {
  clients: { id: string; name: string }[];
  clientId: string;
  verdict: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function setParam(key: string, val: string) {
    const p = new URLSearchParams(sp.toString());
    if (val) p.set(key, val);
    else p.delete(key);
    router.push(`/feedback?${p.toString()}`);
  }

  const chips: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "flag", label: "Flagged" },
    { key: "agree", label: "Agreed" },
  ];
  const activeVerdict = verdict || "all";

  return (
    <div className="flex flex-wrap items-center gap-3">
      {chips.map((c) => {
        const active = activeVerdict === c.key;
        return (
          <button
            key={c.key}
            onClick={() => setParam("verdict", c.key === "all" ? "" : c.key)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              active
                ? "bg-brand-navy text-white"
                : "border border-brand-navy/15 text-muted-foreground hover:border-brand-navy/30 hover:text-brand-navy"
            }`}
          >
            {c.label}
          </button>
        );
      })}
      <select
        value={clientId}
        onChange={(e) => setParam("client", e.target.value)}
        className="rounded-full border border-brand-navy/15 bg-white px-4 py-2 text-sm text-brand-navy outline-none focus:border-brand-navy/35"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
