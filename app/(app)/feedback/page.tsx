import { format, parseISO } from "date-fns";
import { ThumbsUp, Flag } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { FeedbackFilters } from "@/components/feedback/feedback-filters";
import type { Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// Staff Feedback repository (#23): the calibration dataset over match_feedback (migration
// 0013 — capture already exists via /api/feedback; this is the read surface). Serves both
// purposes Shannon named: filter by a client for THAT client's match calibration, or leave
// it unfiltered for the global signal across projects. Admin-only; read-only; no migration.
type FeedbackRow = {
  id: string;
  agree: boolean;
  reason: string | null;
  corrected_score: number | null;
  engine_score: number | null;
  engine_seat_ref: string | null;
  created_by: string | null;
  created_at: string;
  grants: Pick<Grant, "title" | "funder"> | Pick<Grant, "title" | "funder">[] | null;
  clients: { id: string; name: string } | { id: string; name: string }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: { client?: string; verdict?: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const clientId = searchParams.client ?? "";
  const verdict = searchParams.verdict ?? "";

  let query = supabase
    .from("match_feedback")
    .select(
      "id, agree, reason, corrected_score, engine_score, engine_seat_ref, created_by, created_at, grants(title, funder), clients(id, name)",
    )
    .order("created_at", { ascending: false })
    .limit(300);
  if (clientId) query = query.eq("client_id", clientId);
  if (verdict === "agree") query = query.eq("agree", true);
  else if (verdict === "flag") query = query.eq("agree", false);

  const [{ data: rowsData }, { data: profs }, { data: clientList }] = await Promise.all([
    query,
    supabase.from("profiles").select("id, full_name, email"),
    supabase.from("clients").select("id, name").order("name"),
  ]);

  const rows = (rowsData ?? []) as FeedbackRow[];
  const nameById = new Map(
    ((profs ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [
      p.id,
      p.full_name || p.email || "—",
    ]),
  );

  const flags = rows.filter((r) => !r.agree).length;
  const agrees = rows.length - flags;
  const capped = rows.length === 300;

  return (
    <div className="relative min-h-full">
      <div className="relative mx-auto max-w-6xl px-8 py-8">
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">Match feedback</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The calibration dataset — every agree/flag on a match, with the engine&apos;s score at the time. Filter by a
          client to tune their matches, or leave it open for the signal across the whole roster.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <div className="flex gap-4">
            <Stat label="Signals" value={capped ? "300+" : String(rows.length)} />
            <Stat label="Flagged" value={String(flags)} accent />
            <Stat label="Agreed" value={String(agrees)} />
          </div>
        </div>

        <div className="mt-5">
          <FeedbackFilters clients={(clientList ?? []) as { id: string; name: string }[]} clientId={clientId} verdict={verdict} />
        </div>

        <Card className="mt-5 overflow-hidden p-0 shadow-grounded">
          {rows.length === 0 ? (
            <p className="px-6 py-16 text-center text-sm text-muted-foreground">
              No feedback yet for this view. Agree/flag signals from Grant Alerts and the Grant Report land here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-brand-navy/[0.08] text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3">Verdict</th>
                    <th className="px-5 py-3">Client</th>
                    <th className="px-5 py-3">Grant</th>
                    <th className="px-5 py-3">Reason / notes</th>
                    <th className="px-5 py-3">Engine read</th>
                    <th className="px-5 py-3 whitespace-nowrap">By · when</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-navy/[0.05]">
                  {rows.map((r) => {
                    const grant = one(r.grants);
                    const client = one(r.clients);
                    return (
                      <tr key={r.id} className="align-top">
                        <td className="px-5 py-3">
                          {r.agree ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                              <ThumbsUp className="h-3 w-3" /> Agreed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive ring-1 ring-destructive/20">
                              <Flag className="h-3 w-3" /> Flagged
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 font-medium text-brand-navy">{client?.name ?? "—"}</td>
                        <td className="px-5 py-3">
                          <p className="font-medium text-brand-navy">{grant?.title ?? "—"}</p>
                          {grant?.funder && <p className="text-xs text-muted-foreground">{grant.funder}</p>}
                        </td>
                        <td className="max-w-[280px] px-5 py-3 text-muted-foreground">
                          {r.reason ? (
                            <span>{r.reason}</span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                          {r.corrected_score != null && (
                            <span className="mt-1 block text-xs text-brand-orange">suggested fit {r.corrected_score}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">
                          {r.engine_score != null ? `fit ${r.engine_score}` : "—"}
                          {r.engine_seat_ref ? ` · ${r.engine_seat_ref}` : ""}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-xs text-muted-foreground">
                          {r.created_by ? nameById.get(r.created_by) ?? "—" : "—"}
                          <span className="block">{format(parseISO(r.created_at), "MMM d, yyyy")}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className={`font-serif text-2xl font-semibold ${accent ? "text-brand-orange" : "text-brand-navy"}`}>{value}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
