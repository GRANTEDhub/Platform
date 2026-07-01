import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GrantStatusBadge, ScoreBadge } from "@/components/grants/badges";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { AutoRefresh } from "./auto-refresh";
import { RematchButton } from "./rematch-button";
import type { Grant, ReviewCard, Client } from "@/types/database";

export const dynamic = "force-dynamic";

type CardWithClient = ReviewCard & { clients: Pick<Client, "id" | "name" | "org_type"> | null };

export default async function GrantDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireUser();
  const supabase = createClient();

  const { data: grant } = await supabase
    .from("grants")
    .select("*")
    .eq("id", params.id)
    .single<Grant>();

  if (!grant) notFound();

  const { data: cards } = await supabase
    .from("review_cards")
    .select("*, clients(id, name, org_type)")
    .eq("grant_id", params.id)
    .order("fit_score", { ascending: false });

  const matches = (cards ?? []) as CardWithClient[];
  const processing = grant.status === "processing";

  // Client-first gate (read-only here). Track 2's prospect engine will consume
  // the same derivation; nothing enforces it yet.
  const gate = getGrantGateStatus(grant, matches);
  const undecided = undecidedClientCount(matches);

  // Incomplete-scoring visibility. match_attempts is append-only, so reduce to
  // each client's LATEST attempt (max created_at) and count those that errored.
  // This reflects current state regardless of re-scores: a client that errored
  // then later scored fine is not counted; one whose newest attempt is an error
  // is. Distinguishes "complete, nobody matched" from "couldn't score N clients".
  const { data: attempts } = await supabase
    .from("match_attempts")
    .select("client_id, outcome, created_at")
    .eq("grant_id", params.id);

  const latestByClient = new Map<string, { outcome: string; created_at: string }>();
  for (const a of attempts ?? []) {
    if (!a.client_id) continue;
    const prev = latestByClient.get(a.client_id);
    if (!prev || a.created_at > prev.created_at) {
      latestByClient.set(a.client_id, { outcome: a.outcome, created_at: a.created_at });
    }
  }
  const erroredClientCount = [...latestByClient.values()].filter(
    (a) => a.outcome === "error",
  ).length;

  return (
    <div>
      <AutoRefresh enabled={processing} />
      <PageHeader
        title={grant.title || "Processing opportunity…"}
        description={[grant.funder, grant.fon].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex items-center gap-2">
            {grant.activated_from_forecast_at && (
              <Badge variant="secondary">
                Was forecasted, now active · {format(parseISO(grant.activated_from_forecast_at), "MMM d, yyyy")}
              </Badge>
            )}
            {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
            {!processing && (
              <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
                {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
              </Badge>
            )}
            <GrantStatusBadge status={grant.status} />
          </div>
        }
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {processing && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                Shredding the NOFO and scoring it against the client roster… this page
                refreshes automatically.
              </CardContent>
            </Card>
          )}

          {grant.status === "error" && (
            <Card>
              <CardContent className="space-y-2 p-6 text-sm">
                <p className="font-medium text-destructive">Analysis failed</p>
                {grant.error_detail ? (
                  <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {grant.error_detail}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Something went wrong analyzing this opportunity. Check the source link and try again.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {!processing && grant.shred_depth === "summary" && grant.shred_reason && (
            <Card>
              <CardContent className="p-4 text-xs text-muted-foreground">
                Summary shred only — {grant.shred_reason}
              </CardContent>
            </Card>
          )}

          {grant.description && (
            <Card>
              <CardHeader><CardTitle>What it funds</CardTitle></CardHeader>
              <CardContent className="text-sm leading-relaxed">{grant.description}</CardContent>
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

          {erroredClientCount > 0 && !processing && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">Scoring was incomplete</p>
              <p className="mt-1 text-sm text-amber-800">
                {erroredClientCount} client{erroredClientCount === 1 ? "" : "s"} couldn&apos;t be
                scored on the last run — likely a transient API error — so{" "}
                {erroredClientCount === 1 ? "it is" : "they are"} missing from the matches below.
                Re-match to retry.
              </p>
              {profile.role === "admin" && grant.is_domestic && (
                <div className="mt-3">
                  <RematchButton grantId={grant.id} />
                </div>
              )}
            </div>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Matches ({matches.length})</CardTitle>
              {profile.role === "admin" && grant.is_domestic && !processing && (
                <RematchButton grantId={grant.id} />
              )}
            </CardHeader>
            <CardContent>
              {matches.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {processing
                    ? "Scoring in progress…"
                    : !grant.is_domestic
                      ? "International opportunity — excluded from matching by policy."
                      : erroredClientCount > 0
                        ? "Scoring was incomplete — see the notice above. Re-match to retry before treating this as a no-match."
                        : "No qualifying matches (score 2+) for the current roster."}
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {matches.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <Link href={`/review/${m.id}`} className="font-medium hover:underline">
                          {m.clients?.name || "Client"}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {m.proposed_role}
                          {m.recommended_prime ? ` · prime: ${m.recommended_prime}` : ""}
                        </p>
                      </div>
                      <ScoreBadge score={m.fit_score} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Prospecting</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {gate === "not_ready" && (
                <p className="text-muted-foreground">
                  Not ready — grant has not finished scoring against the roster.
                </p>
              )}
              {gate === "released" && (
                <div className="flex items-center gap-2">
                  <Badge variant="success">Released</Badge>
                  <span className="text-muted-foreground">
                    Free to prospect — every client match is decided (or there are none).
                  </span>
                </div>
              )}
              {gate === "locked" && (
                <div className="flex items-center gap-2">
                  <Badge variant="warning">Locked</Badge>
                  <span className="text-muted-foreground">
                    {undecided} client {undecided === 1 ? "match" : "matches"} undecided — clients get first dibs.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

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
        </div>
      </div>
    </div>
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
