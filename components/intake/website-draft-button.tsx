"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

// "Draft from website" control: enabled once the sibling website field holds a
// valid http(s) URL, it asks the server to fetch + summarize the site into a
// {mission, funding_need} draft and hands it back via onDraft. The parent drops
// that into the (still editable) narrative field -- nothing is saved, and it only
// runs on click, so it never auto-populates.
export function WebsiteDraftButton({
  url,
  onDraft,
}: {
  url: string;
  onDraft: (draft: { mission: string; funding_need: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isHttpUrl(url);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/enrich/website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't read that site.");
      onDraft({ mission: data.mission ?? "", funding_need: data.funding_need ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that site.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!valid || busy}
        onClick={run}
        title={valid ? "Draft the narrative from this website" : "Add a website URL above first"}
      >
        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
        {busy ? "Reading the site…" : "Draft from website"}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        {valid
          ? "Pulls a first-draft summary from the site — review and edit before saving."
          : "Add a website URL to enable an AI first draft you can edit."}
      </p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
