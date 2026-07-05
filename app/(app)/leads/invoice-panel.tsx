"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatAmount } from "@/lib/contracts/template";

type ExistingInvoice = {
  status: string; // sent | paid | void | draft
  amountCents: number;
  hostedInvoiceUrl: string | null;
} | null;

// Admin invoice controls on the lead detail page. Requires a signed contract to
// bill against; amount defaults to the contract amount (override allowed).
// Generates a Stripe invoice and surfaces the hosted payment URL for gated/manual
// send -- nothing auto-emails the client. On preview / when Stripe isn't
// configured, the create call reports the gate reason instead of acting.
export function InvoicePanel({
  leadId,
  signedContractAmountCents,
  invoice,
}: {
  leadId: string;
  signedContractAmountCents: number | null;
  invoice: ExistingInvoice;
}) {
  const router = useRouter();
  const [amountDollars, setAmountDollars] = useState<string>(
    signedContractAmountCents != null ? String(signedContractAmountCents / 100) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(invoice?.hostedInvoiceUrl ?? null);
  const [copied, setCopied] = useState(false);

  if (signedContractAmountCents == null && !invoice) {
    return <p className="text-sm text-muted-foreground">Invoice once the contract is signed.</p>;
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const dollars = Number(amountDollars);
      const amountCents = Number.isFinite(dollars) && amountDollars !== "" ? Math.round(dollars * 100) : null;
      const res = await fetch(`/api/leads/${leadId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create invoice.");
      if (data.created) {
        setLink(data.hostedInvoiceUrl ?? null);
        setStatus(data.reused ? "Existing invoice reused." : "Invoice created.");
        router.refresh();
      } else {
        setStatus(`Not created — ${data.reason}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invoice.");
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
      /* clipboard blocked */
    }
  };

  if (invoice?.status === "paid") {
    return (
      <div className="space-y-1 text-sm">
        <div className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          Paid
        </div>
        <p className="text-muted-foreground">{formatAmount(invoice.amountCents)} received.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>
      )}
      {status && (
        <p className="rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">{status}</p>
      )}

      {invoice?.status === "sent" ? (
        <div className="rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">
          Invoice issued ({formatAmount(invoice.amountCents)}) — awaiting payment.
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Amount (USD)</Label>
          <Input type="number" min={0} step={100} value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} />
          <Button type="button" size="sm" disabled={busy} onClick={generate}>
            {busy ? "Creating…" : "Create invoice"}
          </Button>
        </div>
      )}

      {link && (
        <div className="space-y-1">
          <Label>Payment link (copy &amp; send to the client)</Label>
          <div className="flex gap-2">
            <Input readOnly value={link} className="text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Stripe-hosted payment page. No email is sent automatically.</p>
        </div>
      )}
    </div>
  );
}
