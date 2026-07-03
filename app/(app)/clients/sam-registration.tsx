"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Client } from "@/types/database";

// Self-contained SAM.gov registration resolve + confirm. Persists independently
// of the main client form (its own resolve/bind endpoints), because binding is a
// discrete human decision, not part of the profile Save. Compliance/readiness
// only -- nothing here touches matching. Nothing is stored until the human
// confirms a candidate or pastes a UEI.

const UEI_RE = /^[A-HJ-NP-Z0-9]{12}$/;

interface Candidate {
  uei: string;
  legalName: string;
  city: string | null;
  state: string | null;
  status: string | null;
  expirationDate: string | null;
}

type Stored = {
  uei: string | null;
  name: string | null;
  status: string | null;
  expiration: string | null;
  checkedAt: string | null;
};

function CandidateFacts({ c }: { c: Candidate }) {
  const loc = [c.city, c.state].filter(Boolean).join(", ");
  return (
    <div className="text-sm">
      <p className="font-medium">{c.legalName}</p>
      <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {loc && <div>{loc}</div>}
        <div>UEI: {c.uei}</div>
        <div>Status: {c.status ?? "unknown"}</div>
        <div>Expires: {c.expirationDate ?? "unknown"}</div>
      </dl>
    </div>
  );
}

export function SamRegistration({ client }: { client: Client }) {
  const [stored, setStored] = useState<Stored>({
    uei: client.uei,
    name: client.sam_matched_name,
    status: client.sam_registration_status,
    expiration: client.sam_expiration_date,
    checkedAt: client.sam_checked_at,
  });
  const [phase, setPhase] = useState<"idle" | "loading" | "best" | "more" | "manual">("idle");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [manualUei, setManualUei] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(payload: object): Promise<Candidate[] | null> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/sam/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Lookup failed.");
        return null;
      }
      return json.candidates as Candidate[];
    } catch {
      setError("Lookup failed — network error.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startLookup() {
    setPhase("loading");
    const cands = await resolve({});
    if (cands === null) {
      setPhase("idle");
      return;
    }
    setCandidates(cands);
    setPhase(cands.length === 0 ? "manual" : "best");
  }

  async function bind(uei: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/sam/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uei }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not save.");
        return;
      }
      const b = json.bound as Candidate;
      setStored({
        uei: b.uei,
        name: b.legalName,
        status: b.status,
        expiration: b.expirationDate,
        checkedAt: new Date().toISOString(),
      });
      setPhase("idle");
      setCandidates([]);
      setManualUei("");
    } catch {
      setError("Could not save — network error.");
    } finally {
      setBusy(false);
    }
  }

  function submitManual() {
    const u = manualUei.trim().toUpperCase();
    if (!UEI_RE.test(u)) {
      setError("A UEI is 12 letters/numbers (no I or O).");
      return;
    }
    bind(u);
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          SAM registration
        </h2>
        <p className="text-xs text-muted-foreground">
          Admin-only. Confirms this client&apos;s SAM.gov registration to track expiration. Nothing
          is stored until you confirm a match.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Current stored registration */}
      {stored.uei && phase === "idle" && (
        <div className="space-y-2 rounded-lg border border-input p-4">
          <p className="text-sm font-medium">{stored.name ?? "Registered"}</p>
          <dl className="space-y-0.5 text-xs text-muted-foreground">
            <div>UEI: {stored.uei}</div>
            <div>Status: {stored.status ?? "unknown"}</div>
            <div>Expires: {stored.expiration ?? "unknown"}</div>
            {stored.checkedAt && <div>Checked: {new Date(stored.checkedAt).toLocaleDateString()}</div>}
          </dl>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={startLookup}>
            Re-look up
          </Button>
        </div>
      )}

      {/* No registration on file yet */}
      {!stored.uei && phase === "idle" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={busy} onClick={startLookup}>
            Look up SAM registration
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPhase("manual")}>
            Enter UEI manually
          </Button>
        </div>
      )}

      {phase === "loading" && <p className="text-sm text-muted-foreground">Searching SAM.gov…</p>}

      {/* Best guess */}
      {phase === "best" && candidates[0] && (
        <div className="space-y-3 rounded-lg border border-input p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Best match
          </p>
          <CandidateFacts c={candidates[0]} />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => bind(candidates[0].uei)}>
              Confirm
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setPhase(candidates.length > 1 ? "more" : "manual")}
            >
              Not a match
            </Button>
          </div>
        </div>
      )}

      {/* Next candidates */}
      {phase === "more" && (
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Other candidates
          </p>
          {candidates.slice(1, 4).map((c) => (
            <div key={c.uei} className="flex items-start justify-between gap-3 rounded-lg border border-input p-4">
              <CandidateFacts c={c} />
              <Button type="button" size="sm" disabled={busy} onClick={() => bind(c.uei)}>
                This one
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setPhase("manual")}>
            None of these
          </Button>
        </div>
      )}

      {/* Manual UEI fallback */}
      {phase === "manual" && (
        <div className="space-y-3 rounded-lg border border-input p-4">
          <p className="text-sm text-muted-foreground">
            No confirmed match. This is common for newer or unregistered orgs. If they are
            registered, search{" "}
            <a
              href={`https://sam.gov/search/?q=${encodeURIComponent(client.name)}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              SAM.gov
            </a>{" "}
            for their UEI and paste it here.
          </p>
          <div className="space-y-2">
            <Label htmlFor="manual_uei">UEI</Label>
            <Input
              id="manual_uei"
              value={manualUei}
              onChange={(e) => setManualUei(e.target.value)}
              placeholder="12-character UEI"
              maxLength={12}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={submitManual}>
              Use this UEI
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
