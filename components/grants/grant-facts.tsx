import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Grant } from "@/types/database";

// Read-only factual rendering of a shredded grant for the Ledger detail (/grants/[id]).
// Facts only -- no actions live here, so the surface never teleports into an action page.
//
// The grant SUMMARY (title, focus tags, description, the facts strip, grant-level eligibility,
// allowable uses) is rendered by the shared OverviewCard on the page now (PR-C), so the two
// exports below carry only the DEEPER staff analysis OverviewCard does not: the ideal-applicant
// profile, and the deeper key facts (total funding, program type, subawards, scoring rubric,
// high-value criteria, technical burden, incumbent risk, verification, source). The description /
// eligibility / focus-area duplicates OverviewCard now owns were removed here so nothing shows twice.

// The ideal-applicant profile card (the "what a winning applicant looks like" analysis). Kept
// intact from the old GrantOverview; the description + forecasted notice it used to carry moved
// to OverviewCard / the page's own banners.
export function GrantIdealProfile({ grant }: { grant: Grant }) {
  return (
    <>
      {grant.ideal_applicant_profile && (
        <Card>
          <CardHeader><CardTitle>Ideal applicant profile</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Core funded role</p>
              <p className="mt-0.5 font-medium">{grant.ideal_applicant_profile.core_funded_role}</p>
            </div>
            {grant.ideal_applicant_profile.summary && (
              <p className="leading-relaxed text-muted-foreground">{grant.ideal_applicant_profile.summary}</p>
            )}
            <div className="space-y-3">
              {grant.ideal_applicant_profile.archetypes.map((a, i) => (
                <div key={i} className="rounded-md border bg-muted/30 p-3">
                  <p className="font-medium">{a.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Prime shape: {a.ideal_prime_shape}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Core role: {a.core_role}</p>
                  {(a.partner_seats?.length || 0) > 0 && (
                    <div className="mt-2">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Partner seats</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                        {a.partner_seats.map((s, j) => <li key={j}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {grant.ideal_applicant_profile.eligibility_note && (
              <p className="text-xs text-muted-foreground">
                Eligibility (secondary): {grant.ideal_applicant_profile.eligibility_note}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

// The narrow DEEPER-facts / rubric sidebar stack. The summary facts (deadline, award range,
// expected awards, cost share), the eligibility split, and the focus-area chips moved to
// OverviewCard on the page; only what OverviewCard does NOT carry stays here — total funding,
// program type, subawards, scoring rubric, high-value criteria, technical burden, incumbent risk,
// verification, source — so nothing is dropped and nothing is shown twice.
export function GrantDeeperFacts({ grant }: { grant: Grant }) {
  return (
    <>
      <Card>
        <CardHeader><CardTitle>Key facts</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Fact label="Total funding" value={grant.total_funding} />
          <Fact label="Program type" value={grant.program_type} />
          {/* Geography is the one eligibility fact OverviewCard's callout does not carry, so it stays
              here rather than being dropped. Eligible entity types + ineligible-entity limits live in
              the callout; a null geography renders "—". */}
          <Fact label="Geography" value={grant.geographic_eligibility} />
          {grant.subaward_prohibited && (
            <Badge variant="warning">Subawards prohibited — single applicant</Badge>
          )}
        </CardContent>
      </Card>

      {grant.scoring_rubric && Object.keys(grant.scoring_rubric).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Scoring rubric</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {Object.entries(grant.scoring_rubric).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{k}</span>
                <span className="shrink-0 font-medium">{String(v)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(grant.scoring_criteria_high_value?.length || 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>High-value criteria</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm">
              {grant.scoring_criteria_high_value!.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      {(grant.technical_burden_flags?.length || 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Technical burden</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {grant.technical_burden_flags!.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      {grant.incumbent_risk && (
        <Card>
          <CardHeader><CardTitle>Incumbent risk</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">{grant.incumbent_risk}</CardContent>
        </Card>
      )}

      {(grant.verification_flags?.length || 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Verify before acting</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {grant.verification_flags!.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      {grant.source_url && grant.source_url !== "manual-paste" && (
        <a href={grant.source_url} target="_blank" rel="noopener noreferrer" className="block text-sm text-primary hover:underline">
          View source ↗
        </a>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5">{value || "—"}</p>
    </div>
  );
}
