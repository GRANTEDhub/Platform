import type { Client } from "@/types/database";
import { samExpiryFlag } from "@/lib/sam/expiry";

// Per-step status for the post-create enrichment run.
//
// WHY DERIVED, NOT RECORDED: enrichClient is fire-and-forget (waitUntil) and keeps
// no run record. Rather than add a progress table that could disagree with reality,
// each step's state is derived from the ARTIFACT it is supposed to produce. A step
// reads "done" only when its output is actually on the row, so the UI cannot claim
// progress that did not happen. This is what makes the ceremony honest by
// construction instead of by good intentions.
//
// The `*_checked_at` columns are the load-bearing detail: both usaspending-refresh
// and nonprofit-finance-refresh advance them ONLY on a verified result and
// deliberately leave them untouched on failure, so a set timestamp is proof of
// success rather than proof of an attempt.
//
// One thing this derivation genuinely cannot see: the difference between "still
// running" and "ran and failed". Both leave the artifact absent, so both surface as
// `pending`. Callers resolve it with elapsed time (see PENDING_GRACE_MS) and report
// "no result yet" rather than pretending a dead step is still working.

export type EnrichmentStepState =
  // The artifact landed. `detail` quotes what was actually stored.
  | "done"
  // Correctly not applicable to this org -- not a failure. `detail` says why.
  | "skipped"
  // Cannot proceed without a human: a missing input the pull is keyed on.
  | "needs_input"
  // No artifact yet. Either in flight or failed -- indistinguishable from here.
  | "pending";

export type EnrichmentStep = {
  key: "usaspending" | "irs990" | "sam" | "rucc" | "profile";
  label: string;
  source: string;
  state: EnrichmentStepState;
  detail: string | null;
  // Which field on the client form resolves a needs_input step, so the confirm
  // screen can point at the fix instead of just naming the problem.
  resolveField?: "ein" | "location_county" | "sam";
  // Registration health, for the steps where "we have a value" and "the value is
  // still good" are different questions. A SAM registration that expired last month
  // is present AND useless -- reporting only "found it" would hide the thing that
  // actually blocks a submission.
  alert?: "expired" | "soon";
};

// How long a `pending` step is reported as "working" before it is reported as
// "no result yet". The enrichment chain is four sequential network/LLM calls; the
// profile refine alone is an LLM round trip. 45s is comfortably past the normal
// case without leaving a dead step spinning indefinitely.
export const PENDING_GRACE_MS = 45_000;

// Only these org types have an IRS Form 990 to pull. Mirrors the guard in
// nonprofit-finance-refresh's ensureEin -- kept in sync deliberately: if that guard
// widens, this must too, or the UI will promise a pull that never runs.
const NINETY_NINETY_ORG_TYPES = new Set(["nonprofit", "higher_education"]);

function moneyish(n: number | null | undefined): string | null {
  return typeof n === "number" ? `$${n.toLocaleString("en-US")}` : null;
}

export function deriveEnrichmentSteps(client: Client): EnrichmentStep[] {
  const steps: EnrichmentStep[] = [];

  // ── Federal award history (USASpending.gov) ───────────────────────────────
  // A staff-verified self-report wins outright: the refresh short-circuits on
  // federal_history_verified, so reporting "pending" here would be a lie.
  if (client.federal_history_verified) {
    steps.push({
      key: "usaspending",
      label: "Federal award history",
      source: "USASpending.gov",
      state: "skipped",
      detail: "Using the verified self-reported history instead.",
    });
  } else {
    steps.push({
      key: "usaspending",
      label: "Federal award history",
      source: "USASpending.gov",
      state: client.usaspending_checked_at ? "done" : "pending",
      detail: client.usaspending_checked_at
        ? summarizeUsaspending(client.usaspending_summary)
        : null,
    });
  }

  // ── Annual budget (IRS Form 990 via ProPublica) ───────────────────────────
  // Keyed on EIN. When none is stored, ensureEin attempts a NAME lookup that
  // deliberately refuses ambiguous matches -- so "no EIN" is the expected outcome
  // for a common name, not a bug. That is exactly the case a human resolves.
  const orgType = client.org_type ?? "";
  const has990Path = !orgType || NINETY_NINETY_ORG_TYPES.has(orgType);
  const fin = client.nonprofit_finance;
  if (!has990Path) {
    steps.push({
      key: "irs990",
      label: "Annual budget",
      source: "IRS Form 990 (ProPublica)",
      state: "skipped",
      detail: `No Form 990 is filed by a ${orgType.replace(/_/g, " ")} — budget stays manual.`,
    });
  } else if (client.nonprofit_finance_checked_at && fin?.verified) {
    const rev = moneyish(fin.total_revenue);
    const exp = moneyish(fin.total_expenses);
    steps.push({
      key: "irs990",
      label: "Annual budget",
      source: "IRS Form 990 (ProPublica)",
      state: "done",
      detail: [
        fin.fiscal_year ? `FY${fin.fiscal_year}` : null,
        rev ? `revenue ${rev}` : null,
        exp ? `expenses ${exp}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  } else if (!client.ein) {
    steps.push({
      key: "irs990",
      label: "Annual budget",
      source: "IRS Form 990 (ProPublica)",
      state: "needs_input",
      detail:
        "No EIN on file, and the name lookup found no unambiguous match. Add the EIN to pull the 990.",
      resolveField: "ein",
    });
  } else {
    steps.push({
      key: "irs990",
      label: "Annual budget",
      source: "IRS Form 990 (ProPublica)",
      state: "pending",
      detail: null,
    });
  }

  // ── SAM.gov registration ─────────────────────────────────────────────────
  // Not a background pull like the others: binding a UEI is an explicit human
  // decision through the existing SAM resolve/bind flow (two orgs can share a name,
  // and binding the wrong UEI misreports submission readiness). So "unregistered"
  // here means "nobody has bound one yet", which is a to-do, not a failed fetch.
  //
  // Registration STATE matters as much as presence, so expiry is derived at read
  // time from sam_expiration_date -- the same no-stored-flag approach samExpiryFlag
  // already uses for the dashboard.
  const samStatus = (client.sam_registration_status ?? "").trim();
  const samUei = (client.uei ?? "").trim();
  const samExp = (client.sam_expiration_date ?? "").trim();
  if (!samUei && !samStatus) {
    steps.push({
      key: "sam",
      label: "SAM.gov registration",
      source: "SAM.gov",
      state: "needs_input",
      detail: "Unregistered — no UEI bound yet. Required before any federal submission.",
      resolveField: "sam",
    });
  } else {
    const flag = samExpiryFlag(samExp || null);
    const expiredNow = flag?.level === "expired";
    steps.push({
      key: "sam",
      label: "SAM.gov registration",
      source: "SAM.gov",
      // An expired registration is reported as needing attention rather than "done":
      // it is on file, but it will not carry a submission.
      state: expiredNow ? "needs_input" : "done",
      detail: [
        expiredNow ? "EXPIRED" : samStatus || "Registered",
        samUei ? `UEI ${samUei}` : null,
        samExp ? (expiredNow ? `expired ${samExp}` : `expires ${samExp}`) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      resolveField: expiredNow ? "sam" : undefined,
      alert: flag?.level,
    });
  }

  // ── Rurality (USDA ERS county crosswalk) ─────────────────────────────────
  // A local table lookup keyed on county + state, so the only way it cannot run is
  // a missing county.
  const county = (client.location_county ?? "").trim();
  const rucc = (client.rucc_codes ?? "").trim();
  if (rucc) {
    steps.push({
      key: "rucc",
      label: "Rurality (RUCC)",
      source: "USDA ERS 2023 crosswalk",
      state: "done",
      detail: `RUCC ${rucc}`,
    });
  } else if (!county) {
    steps.push({
      key: "rucc",
      label: "Rurality (RUCC)",
      source: "USDA ERS 2023 crosswalk",
      state: "needs_input",
      detail: "No county on file — rurality is derived from county + state.",
      resolveField: "location_county",
    });
  } else {
    steps.push({
      key: "rucc",
      label: "Rurality (RUCC)",
      source: "USDA ERS 2023 crosswalk",
      state: "pending",
      detail: null,
    });
  }

  // ── Client profile distillation ──────────────────────────────────────────
  steps.push({
    key: "profile",
    label: "Profile distillation",
    source: "GRANTED matcher context",
    state: client.client_profile ? "done" : "pending",
    detail: client.client_profile ? "Narrative context built for matching." : null,
  });

  return steps;
}

// Best-effort one-liner from the cached USASpending payload. The cache is typed as
// an open record, so every read is defensive -- a shape change downgrades the copy
// to a generic confirmation rather than throwing on the ceremony screen.
function summarizeUsaspending(summary: Record<string, unknown> | null): string {
  if (!summary) return "Checked — no federal award history found.";
  const count = summary.award_count ?? summary.count ?? summary.total_awards;
  const total = summary.total_obligated ?? summary.total_amount ?? summary.total;
  const parts: string[] = [];
  if (typeof count === "number") parts.push(`${count} prior award${count === 1 ? "" : "s"}`);
  if (typeof total === "number") parts.push(`${moneyish(total)} obligated`);
  return parts.length ? parts.join(" · ") : "Checked — no federal award history found.";
}

// True when nothing is left to wait for: every step has reached a terminal state.
// needs_input IS terminal -- waiting longer will not resolve it, only a human will.
export function allSettled(steps: EnrichmentStep[]): boolean {
  return steps.every((s) => s.state !== "pending");
}

export function needsAttention(steps: EnrichmentStep[]): EnrichmentStep[] {
  return steps.filter((s) => s.state === "needs_input");
}
