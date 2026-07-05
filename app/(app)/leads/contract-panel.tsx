"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { CONTRACT_TEMPLATES, formatAmount, type TemplateKey } from "@/lib/contracts/template";

const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

const TEMPLATE_OPTIONS = Object.values(CONTRACT_TEMPLATES);

type ExistingContract = {
  id: string;
  templateKey: string;
  amountCents: number | null;
  status: string; // sent | signed | draft | void (void filtered out upstream)
  signerName: string | null;
  signedAt: string | null;
  pdfUrl: string | null; // short-lived signed URL to the private PDF (signed state)
} | null;

// Admin contract controls on the lead detail page. If no active contract: pick a
// template + amount and generate a tokenized signing link (shown once to copy).
// If sent: show status + link + regenerate. If signed: show the captured
// signature (name + timestamp). Native e-sign; PDF is a later chunk.
export function ContractPanel({ leadId, contract }: { leadId: string; contract: ExistingContract }) {
  const router = useRouter();
  const [templateKey, setTemplateKey] = useState<TemplateKey>("launch");
  const [amountDollars, setAmountDollars] = useState<string>(
    String((CONTRACT_TEMPLATES.launch.defaultAmountCents ?? 0) / 100),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onTemplateChange = (k: TemplateKey) => {
    setTemplateKey(k);
    const def = CONTRACT_TEMPLATES[k].defaultAmountCents;
    setAmountDollars(def == null ? "" : String(def / 100));
  };

  async function generate() {
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const dollars = Number(amountDollars);
      const amountCents = Number.isFinite(dollars) && amountDollars !== "" ? Math.round(dollars * 100) : null;
      const res = await fetch(`/api/leads/${leadId}/contract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateKey, amountCents }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate contract.");
      setLink(data.url);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate contract.");
    } finally {
      setBusy(false);
    }
  }

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; link is visible to copy manually */
    }
  };

  // Signed: terminal display.
  if (contract?.status === "signed") {
    return (
      <div className="space-y-2 text-sm">
        <div className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          Signed
        </div>
        <Detail label="Package" value={CONTRACT_TEMPLATES[contract.templateKey as TemplateKey]?.name ?? contract.templateKey} />
        <Detail label="Amount" value={formatAmount(contract.amountCents)} />
        <Detail label="Signed by" value={contract.signerName} />
        <Detail
          label="Signed at"
          value={contract.signedAt ? safeFmt(contract.signedAt) : null}
        />
        {contract.pdfUrl ? (
          <a
            href={contract.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs font-medium text-primary hover:underline"
          >
            Download signed PDF ↗
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">Signed PDF is being generated…</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>
      )}

      {contract && (
        <div className="rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">
          Contract sent ({CONTRACT_TEMPLATES[contract.templateKey as TemplateKey]?.name ?? contract.templateKey},{" "}
          {formatAmount(contract.amountCents)}) — awaiting signature. Generating a new link replaces the current one.
        </div>
      )}

      <div className="space-y-2">
        <Label>Package</Label>
        <select value={templateKey} onChange={(e) => onTemplateChange(e.target.value as TemplateKey)} className={SELECT_CLASS}>
          {TEMPLATE_OPTIONS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>Engagement amount (USD)</Label>
        <Input
          type="number"
          min={0}
          step={100}
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          placeholder="e.g. 5000"
        />
      </div>

      <Button type="button" size="sm" disabled={busy} onClick={generate}>
        {busy ? "Generating…" : contract ? "Regenerate signing link" : "Create signing link"}
      </Button>

      {link && (
        <div className="space-y-1">
          <Label>Signing link (copy &amp; send to the client)</Label>
          <div className="flex gap-2">
            <Input readOnly value={link} className="text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Shown once — copy it now. Regenerate if lost.</p>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}: </span>
      <span>{value}</span>
    </div>
  );
}

function safeFmt(v: string): string {
  try {
    return format(parseISO(v), "MMM d, yyyy h:mma");
  } catch {
    return v;
  }
}
