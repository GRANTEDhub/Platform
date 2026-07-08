import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { sanitizeRichText } from "@/lib/sanitize/html";
import { previewHtml, collapseDuplicatedBlock } from "@/lib/grants/description";
import { ExpandableDescription } from "@/components/grants/expandable-description";
import type { Grant } from "@/types/database";

// Read-only factual rendering of a shredded grant, shared by the Ledger detail
// (/grants/[id]) and the Prospects detail (/intel/[id]). Facts only -- no actions
// live here, so neither surface teleports into the other's action page.

// The wide "what it funds + ideal applicant" block.
export function GrantOverview({ grant }: { grant: Grant }) {
  // Sanitized description; long ones truncate (sentence-clean) behind Show more.
  const descClean = grant.description ? sanitizeRichText(collapseDuplicatedBlock(grant.description)) : "";
  const descPreview = previewHtml(descClean);
  const descClass = "[&_li]:ml-4 [&_li]:list-disc [&_ol]:mt-2 [&_ol]:list-decimal [&_p]:mt-2 [&_ul]:mt-2";
  return (
    <>
      {grant.grant_status === "Forecasted" ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            Forecasted — no NOFO published yet.
          </CardContent>
        </Card>
      ) : grant.shred_depth === "summary" && grant.shred_reason ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            Summary shred only — {grant.shred_reason}
          </CardContent>
        </Card>
      ) : null}

      {grant.description && (
        <Card>
          <CardHeader><CardTitle>What it funds</CardTitle></CardHeader>
          <CardContent className="text-sm leading-relaxed">
            {/* Long descriptions truncate (sentence-clean) behind Show more. */}
            {descPreview.truncated ? (
              <ExpandableDescription preview={descPreview.html} full={descClean} className={descClass} />
            ) : (
              <div className={descClass} dangerouslySetInnerHTML={{ __html: descClean }} />
            )}
          </CardContent>
        </Card>
      )}

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

// The narrow key-facts / eligibility / rubric sidebar stack.
export function GrantKeyFacts({ grant }: { grant: Grant }) {
  return (
    <>
      <Card>
        <CardHeader><CardTitle>Key facts</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Fact label="Deadline" value={grant.submission_deadline} />
          <Fact
            label="Award range"
            value={
              grant.award_range_min || grant.award_range_max
                ? `${grant.award_range_min || "?"} – ${grant.award_range_max || "?"}${grant.award_range_is_estimate ? " (estimate)" : ""}`
                : null
            }
          />
          <Fact label="Total funding" value={grant.total_funding} />
          <Fact label="Expected awards" value={grant.num_awards} />
          <Fact label="Cost share / match" value={grant.cost_share} />
          <Fact label="Program type" value={grant.program_type} />
          {grant.subaward_prohibited && (
            <Badge variant="warning">Subawards prohibited — single applicant</Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Eligibility</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Fact label="Eligible entities" value={(grant.eligible_entity_types || []).join(", ") || null} />
          <Fact label="Geography" value={grant.geographic_eligibility} />
          <Fact label="Ineligible" value={grant.ineligible_entities} />
        </CardContent>
      </Card>

      {(grant.focus_areas?.length || 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Focus areas</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {grant.focus_areas!.map((f, i) => (
                <Badge key={i} variant="secondary">{f}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
