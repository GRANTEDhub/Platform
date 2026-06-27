"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type Mode = "url" | "paste";

export function IngestForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/grants/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "url" ? { url: url.trim() } : { rawText: rawText.trim() },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ingest failed");
      router.push(`/grants/${data.grantId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
      setLoading(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Plain-text NOFOs read directly. For PDF/DOCX, paste the text for now.
    if (file.type && !file.type.startsWith("text")) {
      setError("PDF/Word upload is coming soon — paste the NOFO text for now.");
      return;
    }
    setRawText(await file.text());
    setMode("paste");
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex gap-2">
        {(["url", "paste"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              mode === m ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60"
            }`}
          >
            {m === "url" ? "Grant link" : "Paste NOFO"}
          </button>
        ))}
      </div>

      {mode === "url" ? (
        <div className="space-y-2">
          <Label htmlFor="url">Grant URL</Label>
          <Input
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://simpler.grants.gov/opportunities/12345"
          />
          <p className="text-xs text-muted-foreground">
            Simpler.grants.gov links use the official API. Other URLs are scraped for NOFO text.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="rawText">NOFO text</Label>
          <textarea
            id="rawText"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={8}
            placeholder="Paste the notice of funding opportunity text here…"
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <input type="file" accept=".txt,.md,text/*" onChange={onFile} className="text-xs text-muted-foreground" />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={loading || (mode === "url" ? !url.trim() : !rawText.trim())}>
        {loading ? "Analyzing…" : "Shred & match"}
      </Button>
    </form>
  );
}
