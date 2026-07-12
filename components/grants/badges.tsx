import { Badge } from "@/components/ui/badge";
import type { CardDecision } from "@/types/database";

export function ScoreBadge({ score }: { score: 1 | 2 | 3 }) {
  const map = {
    3: { variant: "success" as const, label: "Strong fit" },
    2: { variant: "warning" as const, label: "Conditional" },
    1: { variant: "secondary" as const, label: "Weak" },
  };
  const s = map[score] ?? map[1];
  return <Badge variant={s.variant}>Score {score} · {s.label}</Badge>;
}

export function DecisionBadge({ decision }: { decision: CardDecision }) {
  const map: Record<CardDecision, { variant: "default" | "success" | "warning" | "destructive" | "secondary"; label: string }> = {
    pending: { variant: "secondary", label: "Pending" },
    approved: { variant: "success", label: "Approved" },
    passed: { variant: "destructive", label: "Passed" },
  };
  const d = map[decision] ?? map.pending;
  return <Badge variant={d.variant}>{d.label}</Badge>;
}

export function GrantStatusBadge({
  status,
  grantStatus,
}: {
  status: string;
  grantStatus?: string | null;
}) {
  // Forecasted (the opportunity lifecycle) takes precedence over the operational
  // status -- a forecasted grant with no NOFO reads "Forecasted", not "error".
  if (grantStatus === "Forecasted") return <Badge variant="secondary">Forecasted</Badge>;
  const map: Record<string, "default" | "success" | "warning" | "destructive" | "secondary"> = {
    processing: "default",
    queued: "secondary", // in the matching queue, waiting for the drain
    matching: "default", // drain is scoring it against the roster
    complete: "success",
    error: "destructive",
  };
  return <Badge variant={map[status] ?? "secondary"}>{status}</Badge>;
}
